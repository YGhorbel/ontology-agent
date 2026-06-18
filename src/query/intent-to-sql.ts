/**
 * SQL synthesis (pure, deterministic — no DB I/O, no LLM).
 *
 * Turns a linked `QueryIntent` + the resolved `JoinPath` into a runnable
 * `SELECT … FROM … JOIN … WHERE … GROUP BY … ORDER BY … LIMIT` string. This is the
 * last deterministic seam: schema linking fills the skeleton, the join resolver
 * connects the tables, and this renders the query they jointly describe.
 *
 * Measures render from the ontology's own `formulaHint` (a full aggregate expression
 * like `SUM(results.points)`), so the aggregate function is read, not guessed. Things
 * the SQL cannot faithfully express — a fan-out join under an aggregate, unreachable
 * tables, a low-confidence join, or an empty SELECT — are surfaced as `warnings`
 * rather than silently papered over.
 */
import type { OntologyIndex, ColumnInfo } from './ontology-index.js';
import type { QueryIntent } from '../types/query-intent.js';
import type { JoinPath } from '../types/query-plan.js';
import { isNumericLiteral } from './text-normalize.js';

export interface SqlResult {
  sql: string;
  /** Honest caveats: the SQL reflects only what linked, and may need review. */
  warnings: string[];
}

/** Oriented ON equalities for a resolved join clause, joined by AND. */
export const onSql = (c: { on: Array<{ left: string; right: string }> }): string =>
  c.on.map((p) => `${p.left} = ${p.right}`).join(' AND ');

/** A safe SQL alias slug from a label/column ("order count" → "order_count"). */
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';

/** Quote a filter literal: bare for pure integers, single-quoted (escaped) otherwise. */
const quoteLiteral = (v: string): string => (isNumericLiteral(v) ? v : `'${v.replace(/'/g, "''")}'`);

/** The aggregate SELECT expression for a measure, plus any caveats the caller should surface. */
interface MeasureExpr {
  sql: string;
  /** Set when an ad-hoc aggregate fell back to MAX because the column is a cumulative snapshot. */
  cumulativeColumn?: ColumnInfo;
  /** Set when the measure relies on an LLM-inferred metric formula that was never dry-run-validated. */
  unvalidatedMetric?: string;
}

/** Look up the ColumnInfo for a measure's column, if the ontology carries it. */
function columnInfoOf(measure: QueryIntent['measures'][number], index: OntologyIndex): ColumnInfo | undefined {
  return index.columnsByTable.get(measure.table)?.find((c) => c.column === measure.column);
}

/**
 * The aggregate SELECT expression for a measure. A capability formula (already Fix-2/Fix-3
 * validated at generation time) is used verbatim. Otherwise the default is `SUM`, EXCEPT for a
 * column tagged `cumulative-snapshot` — SUM of a running total double-counts, so we fall back to
 * `MAX` (the ontology's documented safe default) and let the caller warn that last-value-per-group
 * is the precise grain.
 */
function aggregateExpr(measure: QueryIntent['measures'][number], index: OntologyIndex): MeasureExpr {
  const cap = index.capabilities.find(
    (c) =>
      c.kind === 'metric' &&
      c.scopeTable === measure.table &&
      c.scopeColumn === measure.column &&
      (measure.capability === undefined || c.prefLabel === measure.capability),
  );
  if (cap?.formulaHint) {
    const alias = slug(cap.prefLabel ?? measure.column);
    // 'llm' provenance = the formula was inferred but never dry-run-validated (Fix 9 tiers).
    const unvalidatedMetric = cap.provenance === 'llm' ? (cap.prefLabel ?? `${measure.table}.${measure.column}`) : undefined;
    return { sql: `${cap.formulaHint} AS ${alias}`, ...(unvalidatedMetric ? { unvalidatedMetric } : {}) };
  }
  const col = columnInfoOf(measure, index);
  const alias = slug(measure.column);
  if (col?.temporality === 'cumulative-snapshot') {
    return { sql: `MAX(${measure.table}.${measure.column}) AS ${alias}`, cumulativeColumn: col };
  }
  return { sql: `SUM(${measure.table}.${measure.column}) AS ${alias}` };
}

/**
 * Render a `QueryIntent` + its `JoinPath` into a runnable SQL string plus warnings.
 * The intent's tables are assumed to match the join plan's anchor/clauses.
 */
export function intentToSql(intent: QueryIntent, joinPlan: JoinPath, index: OntologyIndex): SqlResult {
  const warnings: string[] = [];

  // SELECT: group dimensions, then projection attributes, then measure aggregates.
  const dimCols = intent.groupDims.map((g) => `${g.table}.${g.column}`);
  const projCols = intent.projection.map((p) => `${p.table}.${p.column}`);
  const nonAgg = [...dimCols, ...projCols];
  const measureExprs = intent.measures.map((m) => aggregateExpr(m, index));
  const selectItems = [...nonAgg, ...measureExprs.map((m) => m.sql)];

  // Cumulative-snapshot measures: we substituted MAX for SUM — flag the precise grain (Fix 3 carried
  // into the query layer). Unvalidated LLM metric formulas are flagged so callers can lower trust.
  for (const m of measureExprs) {
    if (m.cumulativeColumn) {
      const ev = m.cumulativeColumn.temporalityEvidence;
      const grain = ev ? ` — last value per (${ev.partitionColumns.join(', ')}) ordered by ${ev.orderColumn} is the precise grain` : '';
      warnings.push(`${m.cumulativeColumn.column} is a cumulative snapshot; aggregated with MAX, not SUM${grain}`);
    }
    if (m.unvalidatedMetric) {
      warnings.push(`metric "${m.unvalidatedMetric}" formula is LLM-inferred and was not dry-run-validated — verify before trusting`);
    }
  }
  let selectClause: string;
  if (selectItems.length === 0) {
    selectClause = '*';
    warnings.push('no projection, measure, or group dimension linked — defaulting to SELECT *');
  } else {
    selectClause = selectItems.join(', ');
  }

  // FROM / JOIN from the resolved join plan (single-table intent → no JOINs).
  const anchor = joinPlan.anchorTable || intent.tables[0] || '';
  const fromLines = [`FROM ${anchor}`];
  for (const c of joinPlan.clauses) fromLines.push(`JOIN ${c.joinTable} ON ${onSql(c)}`);

  // WHERE from the filters (`=` / `IN`).
  const whereTerms = intent.filters.map((f) => {
    if (f.op === 'in') {
      const lits = f.value.split(', ').map(quoteLiteral).join(', ');
      return `${f.table}.${f.column} IN (${lits})`;
    }
    return `${f.table}.${f.column} = ${quoteLiteral(f.value)}`;
  });

  // GROUP BY only alongside an aggregate (matches the linker's Sprint 3b rule).
  const groupCols = intent.measures.length > 0 ? nonAgg : [];

  const orderTerms = intent.orderBy.map((o) => `${o.table}.${o.column} ${o.dir.toUpperCase()}`);

  const lines = [`SELECT ${selectClause}`, ...fromLines];
  if (whereTerms.length > 0) lines.push(`WHERE ${whereTerms.join(' AND ')}`);
  if (groupCols.length > 0) lines.push(`GROUP BY ${groupCols.join(', ')}`);
  if (orderTerms.length > 0) lines.push(`ORDER BY ${orderTerms.join(', ')}`);
  if (intent.limit != null) lines.push(`LIMIT ${intent.limit}`);

  if (joinPlan.fanOut && intent.measures.length > 0) {
    warnings.push('aggregate over a row-multiplying (fan-out) join may double-count — review grain');
  }
  if (joinPlan.unreachable.length > 0) {
    warnings.push(`unreachable from the join graph: ${joinPlan.unreachable.join(', ')}`);
  }
  if (joinPlan.lowConfidence) {
    warnings.push('join path relies on a low-confidence (discovered) edge');
  }
  if (intent.unresolved.length > 0) {
    warnings.push(`unresolved terms not reflected in SQL: ${intent.unresolved.join(', ')}`);
  }
  if (intent.ambiguities.length > 0) {
    warnings.push(`ambiguous spans resolved to the top candidate: ${intent.ambiguities.map((a) => a.span).join(', ')}`);
  }

  return { sql: `${lines.join('\n')};`, warnings };
}
