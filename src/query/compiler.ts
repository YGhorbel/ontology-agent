/**
 * Stage 3b — the deterministic compiler. IR + SubgraphPayload -> Postgres SQL.
 *
 * "The LLM chooses, the graph constrains, the compiler writes." This file is the
 * writer: it chooses NOTHING about joins (those are Stage 2's, rendered verbatim
 * from `payload.joins`) and consumes ONLY payload facts. There is NO LLM here.
 *
 * Ordered passes (see docs/query/compiler.md):
 *   1. validation / scope coherence   5. filter
 *   2. measure expansion              6. numeric-text cast
 *   3. join materialization           7. assemble + parse-check
 *   4. temporality rewrite (H2)
 *
 * Determinism: relation alias = table name (the Steiner tree visits each table once),
 * so capability formulaHints (`AVG(laptimes.milliseconds)`) expand verbatim and every
 * column reference is stable. The only generated identifiers are `__qsl_snap_rn` (the
 * de-cumulation row number) and any caller-free measure aliases.
 */
import { parse } from 'pgsql-ast-parser';
import type { ColumnProp, SubgraphPayload } from './graph-model.js';
import { tableOfClassIri } from './graph-build.js';
import { referencedColumns } from '../validation/formula-validator.js';
import type { AggFn, FilterOp, MetricQueryIR } from './ir.js';

/** A typed, traceable compile failure — never a silent drop. */
export class CompileError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly offending?: string,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

export interface CompileTraceEntry {
  pass: string;
  detail: string;
}
export interface CompileResult {
  sql: string;
  trace: CompileTraceEntry[];
}

type PayloadJoin = SubgraphPayload['joins'][number];

const NUMERIC_FNS = new Set<AggFn>(['SUM', 'AVG', 'MIN', 'MAX']);
const NUMERIC_COMPARE_OPS = new Set<FilterOp>(['<', '<=', '>', '>=']);

/** `qsl:property/<table>/<column>` -> { table, column }. */
function parsePropertyIri(iri: string): { table: string; column: string } {
  const parts = iri.split('/');
  const column = parts[parts.length - 1] ?? '';
  const table = parts[parts.length - 2] ?? '';
  return { table, column };
}

/** Last segment of a capability IRI, sanitized to a bare SQL identifier (for a default alias). */
function defaultCapabilityAlias(iri: string): string {
  const last = iri.split('/').pop() ?? 'measure';
  return last.replace(/[^A-Za-z0-9_]/g, '_');
}

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
function renderValue(v: string | number | string[]): string {
  if (Array.isArray(v)) return `(${v.map(sqlString).join(', ')})`;
  if (typeof v === 'number') return String(v);
  return sqlString(v);
}

/** A de-cumulation plan for one cumulative-snapshot measure table (H2). */
interface FoldPlan {
  measureTable: string;
  /** The calendar/dimension table folded in to source FOREIGN partition/order columns (null if all LOCAL). */
  calendarTable: string | null;
  /** The payload join consumed by the fold (null when no calendar join is needed). */
  edge: PayloadJoin | null;
  /** Partition columns qualified to their source relation, e.g. `driverstandings.driverid`, `races.year`. */
  partitionExprs: string[];
  /** Order column qualified to its source relation, e.g. `races.round`. */
  orderExpr: string;
  /** FOREIGN column names exposed at the folded alias (partition + order columns living on the calendar). */
  exposed: Set<string>;
}

/** Built-once view of the payload the passes read from. */
interface Scope {
  tables: Set<string>;
  columnsByTable: Map<string, Map<string, ColumnProp>>;
  capByIri: Map<string, SubgraphPayload['capabilities'][number]>;
  joins: PayloadJoin[];
  /** join.from/to are class IRIs; this resolves them to table names. */
  joinTables: (j: PayloadJoin) => { from: string; to: string };
}

function buildScope(payload: SubgraphPayload): Scope {
  const tables = new Set<string>();
  const columnsByTable = new Map<string, Map<string, ColumnProp>>();
  for (const c of payload.classes) {
    const table = tableOfClassIri(c.iri);
    tables.add(table);
    const m = columnsByTable.get(table) ?? new Map<string, ColumnProp>();
    for (const p of c.properties) m.set(p.col, p);
    columnsByTable.set(table, m);
  }
  const capByIri = new Map(payload.capabilities.map((c) => [c.iri, c]));
  return {
    tables,
    columnsByTable,
    capByIri,
    joins: payload.joins,
    joinTables: (j) => ({ from: tableOfClassIri(j.from), to: tableOfClassIri(j.to) }),
  };
}

/** Resolve a property IRI to its column descriptor, or throw a scope-coherence error. */
function resolveColumn(iri: string, scope: Scope): { table: string; column: string; prop: ColumnProp } {
  const { table, column } = parsePropertyIri(iri);
  const cols = scope.columnsByTable.get(table);
  if (!cols || !scope.tables.has(table)) {
    throw new CompileError(`property references table not in payload scope: ${table}`, 'scope-table', table);
  }
  const prop = cols.get(column);
  if (!prop) {
    throw new CompileError(`property references column not in payload: ${table}.${column}`, 'scope-column', `${table}.${column}`);
  }
  return { table, column, prop };
}

// ── Pass 4 helper: plan de-cumulation folds for cumulative-snapshot aggExpr measures ──
function planTemporalityFolds(ir: MetricQueryIR, scope: Scope, trace: CompileTraceEntry[]): Map<string, FoldPlan> {
  const folds = new Map<string, FoldPlan>();
  for (const m of ir.measures ?? []) {
    if (!m.aggExpr) continue; // capability formulaHints expand verbatim (documented known-gap)
    const { table, column, prop } = resolveColumn(m.aggExpr.property, scope);
    if (prop.temporality !== 'cumulative-snapshot') continue;
    if (folds.has(table)) continue; // one fold per measure table; same evidence
    const ev = prop.temporalityEvidence;
    if (!ev) {
      throw new CompileError(
        `column ${table}.${column} is tagged cumulative-snapshot but carries no temporalityEvidence`,
        'temporality-no-evidence',
        `${table}.${column}`,
      );
    }
    const localCols = scope.columnsByTable.get(table)!;
    const allGrain = [...ev.partitionColumns, ev.orderColumn];
    const foreign = allGrain.filter((c) => !localCols.has(c));

    if (foreign.length === 0) {
      // Every partition/order column lives on the measure table — no calendar join needed.
      folds.set(table, {
        measureTable: table,
        calendarTable: null,
        edge: null,
        partitionExprs: ev.partitionColumns.map((c) => `${table}.${c}`),
        orderExpr: `${table}.${ev.orderColumn}`,
        exposed: new Set(),
      });
      trace.push({ pass: 'temporality', detail: `de-cumulate ${table}.${column} (local grain ${allGrain.join(',')})` });
      continue;
    }

    // FOREIGN columns must all live on ONE payload class joined to the measure table by ONE payload edge.
    const foreignSet = new Set(foreign);
    for (const f of foreign) {
      if (localCols.has(f)) {
        throw new CompileError(`fold collision: foreign grain column ${f} also exists on ${table}`, 'temporality-collision', f);
      }
    }
    let calendarTable: string | null = null;
    let edge: PayloadJoin | null = null;
    for (const j of scope.joins) {
      const { from, to } = scope.joinTables(j);
      const other = from === table ? to : to === table ? from : null;
      if (!other) continue;
      const otherCols = scope.columnsByTable.get(other);
      if (!otherCols) continue;
      if ([...foreignSet].every((c) => otherCols.has(c))) {
        calendarTable = other;
        edge = j;
        break;
      }
    }
    if (!calendarTable || !edge) {
      throw new CompileError(
        `cumulative-snapshot grain of ${table}.${column} needs columns [${foreign.join(', ')}] from a calendar ` +
          `table joined in the payload, but none is in scope`,
        'temporality-unreachable',
        `${table}.${column}`,
      );
    }
    const cal = calendarTable;
    const qualify = (c: string): string => (localCols.has(c) ? `${table}.${c}` : `${cal}.${c}`);
    folds.set(table, {
      measureTable: table,
      calendarTable: cal,
      edge,
      partitionExprs: ev.partitionColumns.map(qualify),
      orderExpr: qualify(ev.orderColumn),
      exposed: foreignSet,
    });
    trace.push({
      pass: 'temporality',
      detail: `de-cumulate ${table}.${column}: snapshot at max(${ev.orderColumn}) per (${ev.partitionColumns.join(', ')}); fold ${cal} via ${edge.on.map((p) => p.join('=')).join(',')}`,
    });
  }
  return folds;
}

/** Render the FROM-source for a (possibly folded) table. */
function relationExpr(table: string, folds: Map<string, FoldPlan>, scope: Scope): string {
  const fold = folds.get(table);
  if (!fold) return table;
  const rn = `ROW_NUMBER() OVER (PARTITION BY ${fold.partitionExprs.join(', ')} ORDER BY ${fold.orderExpr} DESC) AS __qsl_snap_rn`;
  if (!fold.calendarTable || !fold.edge) {
    return `(SELECT ${table}.*, ${rn} FROM ${table}) AS ${table}`;
  }
  const { from, to } = scope.joinTables(fold.edge);
  const on = fold.edge.on.map(([a, b]) => `${from}.${a} = ${to}.${b}`).join(' AND ');
  const exposed = [...fold.exposed].map((c) => `${fold.calendarTable}.${c} AS ${c}`).join(', ');
  return `(SELECT ${table}.*, ${exposed}, ${rn} FROM ${table} JOIN ${fold.calendarTable} ON ${on}) AS ${table}`;
}

/** Resolve a property IRI to a SQL column reference, remapping folded-away calendar columns to the fold alias. */
function refExpr(iri: string, scope: Scope, folds: Map<string, FoldPlan>): { sql: string; prop: ColumnProp } {
  const { table, column, prop } = resolveColumn(iri, scope);
  for (const fold of folds.values()) {
    if (fold.calendarTable === table) {
      if (fold.exposed.has(column)) return { sql: `${fold.measureTable}.${column}`, prop };
      throw new CompileError(
        `column ${table}.${column} belongs to a calendar table folded into ${fold.measureTable}; only its grain ` +
          `columns are projected`,
        'temporality-folded-column',
        `${table}.${column}`,
      );
    }
  }
  return { sql: `${table}.${column}`, prop };
}

// ── Pass 3 helper: materialize FROM + JOINs verbatim from payload.joins, minus consumed fold edges ──
function buildFrom(scope: Scope, folds: Map<string, FoldPlan>, trace: CompileTraceEntry[]): string {
  const foldedAway = new Set<string>();
  const consumed = new Set<PayloadJoin>();
  for (const f of folds.values()) {
    if (f.calendarTable) foldedAway.add(f.calendarTable);
    if (f.edge) consumed.add(f.edge);
  }
  const outerTables = [...scope.tables].filter((t) => !foldedAway.has(t)).sort();
  const activeJoins = scope.joins.filter((j) => !consumed.has(j));

  if (activeJoins.length === 0) {
    const root = outerTables[0];
    if (root === undefined) throw new CompileError('empty payload: no tables to compile', 'empty-scope');
    trace.push({ pass: 'join', detail: `FROM ${root} (no joins)` });
    return `FROM ${relationExpr(root, folds, scope)}`;
  }

  const emitted = new Set<string>();
  const rootTable = scope.joinTables(activeJoins[0]!).from;
  emitted.add(rootTable);
  const parts = [`FROM ${relationExpr(rootTable, folds, scope)}`];
  const remaining = [...activeJoins];
  for (;;) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const j = remaining[i]!;
      const { from, to } = scope.joinTables(j);
      const fromIn = emitted.has(from);
      const toIn = emitted.has(to);
      if (fromIn && toIn) {
        remaining.splice(i, 1); // already connected (defensive; tree has no cycles)
        i--;
        progressed = true;
        continue;
      }
      if (!fromIn && !toIn) continue; // not yet reachable — a later pass connects it
      const child = fromIn ? to : from;
      const on = j.on.map(([a, b]) => `${from}.${a} = ${to}.${b}`).join(' AND ');
      parts.push(`JOIN ${relationExpr(child, folds, scope)} ON ${on}`);
      emitted.add(child);
      remaining.splice(i, 1);
      i--;
      progressed = true;
    }
    if (remaining.length === 0 || !progressed) break;
  }
  if (remaining.length > 0) {
    throw new CompileError('payload joins do not form a connected tree from the chosen root', 'join-disconnected');
  }
  trace.push({ pass: 'join', detail: `${activeJoins.length} join(s) rendered verbatim from payload` });
  return parts.join('\n');
}

/** Apply a numeric CAST to a column reference iff it is a numeric-text column used numerically (pass 6). */
function maybeCast(sql: string, prop: ColumnProp, numeric: boolean, trace: CompileTraceEntry[]): string {
  if (numeric && prop.isNumericText) {
    trace.push({ pass: 'cast', detail: `CAST(${sql} AS numeric) — numeric-text column` });
    return `CAST(${sql} AS numeric)`;
  }
  return sql;
}

export function compile(ir: MetricQueryIR, payload: SubgraphPayload): CompileResult {
  const trace: CompileTraceEntry[] = [];
  const scope = buildScope(payload);

  // ── Pass 1: validation / scope coherence ──
  for (const m of ir.measures ?? []) {
    if (m.capability !== undefined) {
      const cap = scope.capByIri.get(m.capability);
      if (!cap) throw new CompileError(`capability not in payload: ${m.capability}`, 'scope-capability', m.capability);
      if (!cap.formulaHint) {
        throw new CompileError(`capability ${m.capability} has no formulaHint to expand`, 'capability-no-formula', m.capability);
      }
      for (const ref of referencedColumns(cap.formulaHint)) {
        if (!scope.tables.has(ref.table)) {
          throw new CompileError(
            `capability ${m.capability} formula references table out of scope: ${ref.table}`,
            'scope-table',
            ref.table,
          );
        }
      }
    } else if (m.aggExpr !== undefined) {
      resolveColumn(m.aggExpr.property, scope); // throws on out-of-scope table/column
    }
  }
  for (const s of ir.select ?? []) resolveColumn(s.property, scope);
  for (const g of ir.groupBy ?? []) resolveColumn(g.property, scope);
  for (const f of ir.filters ?? []) resolveColumn(f.property, scope);
  for (const o of ir.orderBy ?? []) if (o.byProperty) resolveColumn(o.byProperty, scope);
  trace.push({ pass: 'validation', detail: 'all IRIs resolve in payload scope' });

  // ── Pass 4 (planned before SELECT so expansion/joins see the folds): temporality ──
  const folds = planTemporalityFolds(ir, scope, trace);
  if (folds.size === 0) trace.push({ pass: 'temporality', detail: 'no cumulative-snapshot measures' });

  // ── Pass 2: projection (select) OR measure expansion (+ pass 6 cast for aggExpr columns) ──
  const selectItems: string[] = [];
  const groupExprs: string[] = [];
  // projection / ranking: bare qualified columns, no aggregate, no GROUP BY
  for (const s of ir.select ?? []) {
    const { sql } = refExpr(s.property, scope, folds);
    selectItems.push(sql);
    trace.push({ pass: 'select', detail: `projection ${sql}` });
  }
  for (const g of ir.groupBy ?? []) {
    const { sql } = refExpr(g.property, scope, folds);
    const { column } = parsePropertyIri(g.property);
    groupExprs.push(sql);
    selectItems.push(`${sql} AS ${column}`);
  }
  (ir.measures ?? []).forEach((m, i) => {
    if (m.capability !== undefined) {
      const cap = scope.capByIri.get(m.capability)!;
      const alias = m.alias ?? defaultCapabilityAlias(m.capability);
      selectItems.push(`${cap.formulaHint} AS ${alias}`);
      trace.push({ pass: 'measure', detail: `capability ${m.capability} -> ${cap.formulaHint}` });
    } else {
      const fn = m.aggExpr!.fn;
      const { sql, prop } = refExpr(m.aggExpr!.property, scope, folds);
      const casted = maybeCast(sql, prop, NUMERIC_FNS.has(fn), trace);
      const { column } = parsePropertyIri(m.aggExpr!.property);
      const alias = m.alias ?? `${fn.toLowerCase()}_${column}`;
      selectItems.push(`${fn}(${casted}) AS ${alias}`);
      trace.push({ pass: 'measure', detail: `aggExpr ${fn}(${casted})` });
    }
    void i;
  });

  // ── Pass 3: join materialization ──
  const fromSql = buildFrom(scope, folds, trace);

  // ── Pass 5 + 6: filters (with numeric-text cast) ──
  const conds: string[] = [];
  for (const f of ir.filters ?? []) {
    const { sql, prop } = refExpr(f.property, scope, folds);
    const numeric = NUMERIC_COMPARE_OPS.has(f.op) || ((f.op === '=' || f.op === '!=') && typeof f.value === 'number');
    const lhs = maybeCast(sql, prop, numeric, trace);
    conds.push(`${lhs} ${f.op} ${renderValue(f.value)}`);
  }
  // de-cumulation snapshot filter(s)
  for (const fold of folds.values()) conds.push(`${fold.measureTable}.__qsl_snap_rn = 1`);
  if (conds.length > 0) trace.push({ pass: 'filter', detail: `${conds.length} WHERE condition(s)` });

  // ── Pass 7: assemble ──
  const lines = [`SELECT ${ir.distinct ? 'DISTINCT ' : ''}${selectItems.join(', ')}`, fromSql];
  if (conds.length > 0) lines.push(`WHERE ${conds.join(' AND ')}`);
  if (groupExprs.length > 0) lines.push(`GROUP BY ${groupExprs.join(', ')}`);
  const orderParts: string[] = [];
  for (const o of ir.orderBy ?? []) {
    let target: string;
    if (o.byAlias !== undefined) {
      target = o.byAlias;
    } else {
      // Ordering by a property is a numeric context: numeric-text columns must sort numerically,
      // not lexically (maybeCast no-ops on real numeric/date/text columns).
      const { sql, prop } = refExpr(o.byProperty!, scope, folds);
      target = maybeCast(sql, prop, true, trace);
    }
    const nulls = o.nulls ? ` NULLS ${o.nulls}` : '';
    orderParts.push(`${target} ${o.dir}${nulls}`);
  }
  if (orderParts.length > 0) lines.push(`ORDER BY ${orderParts.join(', ')}`);
  if (ir.limit !== undefined) lines.push(`LIMIT ${ir.limit}`);
  const sql = lines.join('\n');

  // ── Pass 7: parse-check with the same parser the formula validator uses ──
  try {
    parse(sql);
  } catch (err) {
    throw new CompileError(
      `compiled SQL failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      'parse',
      sql,
    );
  }
  trace.push({ pass: 'assemble', detail: 'SELECT/FROM/WHERE/GROUP BY/ORDER BY/LIMIT composed and parsed' });

  return { sql, trace };
}
