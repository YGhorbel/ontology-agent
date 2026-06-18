/**
 * _draft_f1_gold.ts — DRAFT generator for the non-cumulative F1-50 gold items.
 *
 * NOT a gold producer. Pulls BIRD mini-dev formula_1 records, runs their transpiled
 * Postgres SQL against the reloaded formula1 DB (read-only), captures rows, and FLAGS
 * suspicious shapes. Cumulative-touching items are routed to a separate file for the
 * human to author. Nothing here certifies correctness: `note` is always "", stratum is a
 * "guess", flags are heuristic. Underscore-prefixed outputs mark everything as draft.
 *
 * DSN is read from env (EVAL_FORMULA1_DSN); never hardcoded. Reuses eval/src/db.ts.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'pgsql-ast-parser';
import { makeReadOnlyDbHandle } from '../src/db.js';

const REPO = join(import.meta.dirname, '..', '..');
const GOLD = join(REPO, 'eval', 'gold', 'bird_minidev_postgresql.json');
const OUT_DIR = join(REPO, 'eval', 'gold');

const TIME_LIKE = new Set(['q1', 'q2', 'q3', 'time', 'duration', 'fastestlaptime', 'fastestlapspeed']);

// ---------------------------------------------------------------------------
// Ontology facts
// ---------------------------------------------------------------------------
interface OntoFacts {
  cumulativeCols: Set<string>; // "table.col"
  textCols: Set<string>;
  numericTextCols: Set<string>;
  sampleValues: Map<string, string[]>;
  colsByTable: Map<string, Set<string>>; // table -> col names (to resolve unqualified refs)
}

function latestOntology(): string {
  const dir = join(REPO, 'out');
  const files = readdirSync(dir).filter((f) => /^ontology-formula1-.*\.jsonld$/.test(f)).sort();
  if (files.length === 0) throw new Error('no formula1 ontology in out/');
  return join(dir, files[files.length - 1]!);
}

function loadOnto(path: string): OntoFacts {
  const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const graph = [
    ...((o['@graph'] as unknown[]) ?? []),
    ...((o['qsl:candidateGraph'] as unknown[]) ?? []),
  ] as Array<Record<string, unknown>>;
  const f: OntoFacts = {
    cumulativeCols: new Set(),
    textCols: new Set(),
    numericTextCols: new Set(),
    sampleValues: new Map(),
    colsByTable: new Map(),
  };
  for (const n of graph) {
    const t = n['qsl:mapsToTable'];
    const c = n['qsl:mapsToColumn'];
    if (typeof t !== 'string' || typeof c !== 'string') continue;
    const tc = `${t.toLowerCase()}.${c.toLowerCase()}`;
    if (!f.colsByTable.has(t.toLowerCase())) f.colsByTable.set(t.toLowerCase(), new Set());
    f.colsByTable.get(t.toLowerCase())!.add(c.toLowerCase());
    if (n['qsl:temporality'] === 'cumulative-snapshot') f.cumulativeCols.add(tc);
    if (n['qsl:dataType'] === 'text') f.textCols.add(tc);
    if (n['qsl:isNumericText'] === true) f.numericTextCols.add(tc);
    const sv = n['qsl:sampleValues'];
    if (Array.isArray(sv)) f.sampleValues.set(tc, sv.map((x) => String(x)));
  }
  return f;
}

// ---------------------------------------------------------------------------
// SQL shape analysis (pgsql-ast-parser) — heuristic, never rewrites the SQL
// ---------------------------------------------------------------------------
interface Agg { fn: string; table: string | null; col: string }
interface Lit { table: string | null; col: string; literal: string }
interface SqlShape {
  parsed: boolean;
  tables: Set<string>;
  aliasMap: Map<string, string>;
  joinCount: number;
  compositeJoin: boolean;
  hasGroupBy: boolean;
  hasDistinct: boolean;
  hasLimit: boolean;
  hasOrderBy: boolean;
  orderRefs: Array<{ table: string | null; col: string; nulls: boolean }>;
  aggs: Agg[];
  literals: Lit[];
}

function walk(node: unknown, fn: (n: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, fn); return; }
  const obj = node as Record<string, unknown>;
  fn(obj);
  for (const k of Object.keys(obj)) walk(obj[k], fn);
}

function analyzeSql(sql: string): SqlShape {
  const shape: SqlShape = {
    parsed: false, tables: new Set(), aliasMap: new Map(), joinCount: 0, compositeJoin: false,
    hasGroupBy: false, hasDistinct: false, hasLimit: false, hasOrderBy: false,
    orderRefs: [], aggs: [], literals: [],
  };
  let ast: unknown[];
  try { ast = parse(sql) as unknown[]; } catch { return shape; }
  shape.parsed = true;
  const stmt = ast[0] as Record<string, unknown> | undefined;
  if (!stmt) return shape;

  // alias map + tables (from any 'table' node anywhere)
  walk(stmt, (n) => {
    if (n['type'] === 'table') {
      const name = n['name'] as { name?: string; alias?: string } | undefined;
      if (name?.name) {
        const real = name.name.toLowerCase();
        shape.tables.add(real);
        shape.aliasMap.set(real, real);
        if (name.alias) shape.aliasMap.set(name.alias.toLowerCase(), real);
      }
    }
  });
  const resolve = (ref: { table?: { name?: string }; name?: string }): { table: string | null; col: string } => {
    const col = (ref.name ?? '').toLowerCase();
    const a = ref.table?.name?.toLowerCase();
    if (a && shape.aliasMap.has(a)) return { table: shape.aliasMap.get(a)!, col };
    if (a) return { table: a, col };
    // unqualified: resolve if unique among tables used
    return { table: null, col };
  };

  shape.hasGroupBy = Array.isArray(stmt['groupBy']) && (stmt['groupBy'] as unknown[]).length > 0;
  const distinct = stmt['distinct'];
  shape.hasDistinct = distinct === 'distinct' || Array.isArray(distinct);
  shape.hasLimit = stmt['limit'] != null;
  const orderBy = stmt['orderBy'];
  shape.hasOrderBy = Array.isArray(orderBy) && (orderBy as unknown[]).length > 0;
  if (Array.isArray(orderBy)) {
    for (const ob of orderBy as Array<Record<string, unknown>>) {
      const by = ob['by'] as Record<string, unknown> | undefined;
      const nulls = ob['nulls'] != null;
      if (by && by['type'] === 'ref') {
        const r = resolve(by as { table?: { name?: string }; name?: string });
        shape.orderRefs.push({ ...r, nulls });
      } else {
        shape.orderRefs.push({ table: null, col: '<expr>', nulls });
      }
    }
  }

  // joins: count join targets + composite ON detection
  const from = stmt['from'];
  if (Array.isArray(from)) {
    for (const el of from as Array<Record<string, unknown>>) {
      const jn = el['join'] as Record<string, unknown> | undefined;
      if (jn) {
        shape.joinCount += 1;
        const on = jn['on'];
        const eqCols = new Set<string>();
        let eqCount = 0;
        walk(on, (n) => {
          if (n['type'] === 'binary' && n['op'] === '=') {
            const l = n['left'] as Record<string, unknown>;
            const r = n['right'] as Record<string, unknown>;
            if (l?.['type'] === 'ref' && r?.['type'] === 'ref') {
              eqCount += 1;
              eqCols.add(String(l['name']).toLowerCase());
              eqCols.add(String(r['name']).toLowerCase());
            }
          }
        });
        const hasRaceCompound = eqCols.has('raceid') && (eqCols.has('driverid') || eqCols.has('constructorid'));
        if (eqCount > 1 || hasRaceCompound) shape.compositeJoin = true;
      }
    }
  }

  // aggregates: call nodes with agg fn, arg ref resolved to table.col
  walk(stmt, (n) => {
    if (n['type'] === 'call') {
      const fname = ((n['function'] as { name?: string } | undefined)?.name ?? '').toLowerCase();
      if (['sum', 'avg', 'count', 'max', 'min', 'total'].includes(fname)) {
        walk(n['args'], (a) => {
          if (a['type'] === 'ref' && a['name']) {
            const r = resolve(a as { table?: { name?: string }; name?: string });
            shape.aggs.push({ fn: fname, table: r.table, col: r.col });
          }
        });
      }
    }
  });

  // literal equality / IN filters (string literals only) in WHERE
  walk(stmt['where'], (n) => {
    if (n['type'] === 'binary' && (n['op'] === '=' || String(n['op']).toUpperCase() === 'IN')) {
      const l = n['left'] as Record<string, unknown>;
      const right = n['right'] as Record<string, unknown>;
      if (l?.['type'] === 'ref') {
        const r = resolve(l as { table?: { name?: string }; name?: string });
        const strings: string[] = [];
        walk(right, (rn) => { if (rn['type'] === 'string' && typeof rn['value'] === 'string') strings.push(rn['value']); });
        for (const s of strings) shape.literals.push({ table: r.table, col: r.col, literal: s });
      }
    }
  });

  return shape;
}

/** Resolve an unqualified col to a table if unique among tables used. */
function resolveUnqualified(col: string, tables: Set<string>, onto: OntoFacts): string | null {
  const hits = [...tables].filter((t) => onto.colsByTable.get(t)?.has(col));
  return hits.length === 1 ? hits[0]! : null;
}

// ---------------------------------------------------------------------------
// Flagging + classification
// ---------------------------------------------------------------------------
interface Flag { flag: string; detail: string }

function computeFlags(
  rec: { question: string; SQL: string },
  shape: SqlShape,
  onto: OntoFacts,
  rows: unknown[][] | null,
  errorText: string | null,
): { flags: Flag[]; cumulativeSum: boolean; cumulativeCandidate: boolean } {
  const flags: Flag[] = [];
  const sql = rec.SQL;
  const q = rec.question;

  if (errorText !== null) {
    flags.push({ flag: 'ERROR', detail: errorText.split('\n')[0] ?? errorText });
  } else if (rows && rows.length === 0) {
    flags.push({ flag: 'EMPTY', detail: 'query returned zero rows' });
  }

  // CUMULATIVE_SUM: SUM/AVG over a cumulative-snapshot column
  let cumulativeSum = false;
  const cumulativeColsHit: string[] = [];
  for (const a of shape.aggs) {
    const table = a.table ?? resolveUnqualified(a.col, shape.tables, onto);
    const ambiguous = a.table === null && table === null;
    // for ambiguity, check if ANY used table makes it cumulative
    const candidates = table ? [`${table}.${a.col}`] : [...shape.tables].map((t) => `${t}.${a.col}`);
    const hit = candidates.find((tc) => onto.cumulativeCols.has(tc));
    if (hit) {
      cumulativeColsHit.push(hit);
      if (a.fn === 'sum' || a.fn === 'avg') {
        cumulativeSum = true;
        flags.push({
          flag: 'CUMULATIVE_SUM',
          detail: `${a.fn.toUpperCase()}(${hit})${ambiguous ? ' [unqualified/ambiguous]' : ''} — BIRD SQL aggregates a cumulative-snapshot column`,
        });
      }
    }
  }
  // cumulative-CANDIDATE stratum: standings tables aggregated on points/wins
  const cumulativeCandidate =
    [...shape.tables].some((t) => t === 'driverstandings' || t === 'constructorstandings') &&
    shape.aggs.some(
      (a) => ['points', 'wins'].includes(a.col) &&
        (a.table === 'driverstandings' || a.table === 'constructorstandings' ||
          (a.table === null && resolveUnqualified(a.col, shape.tables, onto) !== null)),
    );

  // TEXT_ORDER: ORDER BY on a text col holding time/numeric-looking values
  for (const o of shape.orderRefs) {
    const table = o.table ?? resolveUnqualified(o.col, shape.tables, onto);
    const tc = table ? `${table}.${o.col}` : null;
    const isText = tc ? onto.textCols.has(tc) : false;
    const looksTime = TIME_LIKE.has(o.col) || (tc ? onto.numericTextCols.has(tc) : false);
    if (looksTime && (isText || TIME_LIKE.has(o.col))) {
      flags.push({ flag: 'TEXT_ORDER', detail: `ORDER BY ${tc ?? o.col} (text, time/numeric-looking) — lexical vs temporal sort risk` });
    }
  }

  // NULL_ORDER: explicit NULLS clause, or ORDER BY+LIMIT where NULLs could change LIMIT selection
  if (/\bNULLS\s+(FIRST|LAST)\b/i.test(sql)) {
    flags.push({ flag: 'NULL_ORDER', detail: 'explicit NULLS FIRST/LAST — verify NULL placement vs intended selection' });
  } else if (shape.hasOrderBy && shape.hasLimit) {
    const timeOrder = shape.orderRefs.some((o) => {
      const table = o.table ?? resolveUnqualified(o.col, shape.tables, onto);
      const tc = table ? `${table}.${o.col}` : null;
      return TIME_LIKE.has(o.col) || (tc ? onto.numericTextCols.has(tc) || onto.textCols.has(tc) : false);
    });
    if (timeOrder) flags.push({ flag: 'NULL_ORDER', detail: 'ORDER BY (nullable/text) + LIMIT — NULLs may change which rows the LIMIT keeps' });
  }

  // INT_DIV: division in a ratio/percentage question without a real/numeric cast
  if (/\//.test(sql) && /percent|percentage|ratio|rate|proportion|average/i.test(q)) {
    // any real/numeric cast in the query is taken as protecting the division (nested-paren
    // safe: matches `AS REAL` / `::numeric` anywhere rather than trying to bracket the CAST).
    const casted = /::\s*(real|numeric|float|double)|\bas\s+(real|numeric|float|double(\s+precision)?)\b/i.test(sql);
    if (!casted) flags.push({ flag: 'INT_DIV', detail: 'division in a ratio/percentage question with no real/numeric cast — integer-division truncation risk' });
  }

  // LITERAL_UNVERIFIED: string-equality/IN literals vs ontology sampleValues
  for (const lit of shape.literals) {
    const table = lit.table ?? resolveUnqualified(lit.col, shape.tables, onto);
    const tc = table ? `${table}.${lit.col}` : null;
    const sv = tc ? onto.sampleValues.get(tc) : undefined;
    const inSamples = sv ? sv.includes(lit.literal) : null;
    flags.push({
      flag: 'LITERAL_UNVERIFIED',
      detail: `${tc ?? lit.col} = '${lit.literal}' → inSampleValues=${inSamples === null ? 'unknown(no sampleValues)' : inSamples}`,
    });
  }

  // FANOUT: join, no grouping/distinct, implausibly many rows
  if (rows && shape.joinCount >= 1 && !shape.hasGroupBy && !shape.hasDistinct && rows.length > 50) {
    flags.push({ flag: 'FANOUT', detail: `joinCount=${shape.joinCount}, rowCount=${rows.length}, no GROUP BY/DISTINCT — possible join fan-out` });
  }

  return { flags, cumulativeSum, cumulativeCandidate };
}

function classifyStratum(shape: SqlShape, onto: OntoFacts): string {
  if (shape.compositeJoin) return 'composite-join';
  // enum-filter: text equality/IN on an enum-ish col (has sampleValues in ontology)
  const enumish = shape.literals.some((lit) => {
    const table = lit.table ?? resolveUnqualified(lit.col, shape.tables, onto);
    const tc = table ? `${table}.${lit.col}` : null;
    return tc ? onto.sampleValues.has(tc) : false;
  });
  if (enumish) return 'enum-filter';
  if (shape.joinCount === 0) return 'single-table';
  if (shape.joinCount >= 1) return 'declared-join';
  return 'single-table';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const dsn = process.env.EVAL_FORMULA1_DSN;
  if (!dsn) {
    console.error('FATAL: set EVAL_FORMULA1_DSN in env (read from compose conn_map; do not hardcode).');
    process.exit(2);
  }
  const onto = loadOnto(latestOntology());
  const gold = JSON.parse(readFileSync(GOLD, 'utf8')) as Array<Record<string, unknown>>;
  const f1 = gold.filter((r) => r['db_id'] === 'formula_1');

  const db = await makeReadOnlyDbHandle(dsn, 'formula1');
  const draftRows: unknown[] = [];
  const cumulativeRows: unknown[] = [];
  const reportFlags: Array<{ id: string; question: string; flag: string; detail: string }> = [];
  const stratumCount: Record<string, number> = {};

  try {
    for (const rec of f1) {
      const qid = rec['question_id'];
      const id = `f1-bird-${qid}`;
      const sql = String(rec['SQL']);
      const question = String(rec['question']);

      let rows: unknown[][] | null = null;
      let errorText: string | null = null;
      try {
        rows = (await db.query(sql)).rows;
      } catch (e) {
        errorText = e instanceof Error ? e.message : String(e);
      }

      const shape = analyzeSql(sql);
      const { flags, cumulativeSum, cumulativeCandidate } = computeFlags(
        { question, SQL: sql }, shape, onto, rows, errorText,
      );
      const baseStratum = classifyStratum(shape, onto);
      const routeCumulative = cumulativeCandidate || cumulativeSum;
      const stratum = routeCumulative ? 'cumulative-CANDIDATE' : baseStratum;

      for (const fl of flags) reportFlags.push({ id, question, flag: fl.flag, detail: fl.detail });

      const item = {
        id,
        dbName: 'formula1',
        question,
        goldSql: sql,
        goldRows: errorText ? null : rows,
        stratum,
        note: '',
        stratumConfidence: 'guess',
        _draft: {
          birdEvidence: rec['evidence'] ?? '',
          birdDifficulty: rec['difficulty'] ?? '',
          rowCount: rows ? rows.length : null,
          flags,
        },
      };

      if (routeCumulative) {
        cumulativeRows.push(item);
      } else {
        draftRows.push(item);
        stratumCount[stratum] = (stratumCount[stratum] ?? 0) + 1;
      }
    }
  } finally {
    const closable = db as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') await closable.close();
  }

  // Write draft + cumulative JSONL
  writeFileSync(join(OUT_DIR, '_f1-draft.jsonl'), draftRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(OUT_DIR, '_cumulative-candidates.jsonl'), cumulativeRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Report
  const byFlag = new Map<string, typeof reportFlags>();
  for (const rf of reportFlags) {
    if (!byFlag.has(rf.flag)) byFlag.set(rf.flag, []);
    byFlag.get(rf.flag)!.push(rf);
  }
  const order = ['CUMULATIVE_SUM', 'TEXT_ORDER', 'NULL_ORDER', 'INT_DIV', 'FANOUT', 'EMPTY', 'ERROR', 'LITERAL_UNVERIFIED'];
  const lines: string[] = [];
  lines.push('# F1-50 DRAFT report (NOT verified gold)');
  lines.push('');
  lines.push('> Heuristic draft. `note`=""; stratum is a guess (`stratumConfidence: "guess"`); flags are heuristic.');
  lines.push('> Cumulative-touching items are in `_cumulative-candidates.jsonl`, NOT the main draft. Verify by hand.');
  lines.push('');
  lines.push(`- formula_1 records processed: **${f1.length}**`);
  lines.push(`- non-cumulative draft items (\`_f1-draft.jsonl\`): **${draftRows.length}**`);
  lines.push(`- cumulative candidates (\`_cumulative-candidates.jsonl\`): **${cumulativeRows.length}**`);
  lines.push('');
  lines.push('## Guessed stratum counts (non-cumulative draft)');
  lines.push('');
  lines.push('| stratum | count |');
  lines.push('|---|---|');
  for (const [s, c] of Object.entries(stratumCount).sort()) lines.push(`| ${s} | ${c} |`);
  lines.push('');
  lines.push('## FLAGS (top: CUMULATIVE_SUM, TEXT_ORDER)');
  lines.push('');
  const flagKeys = [...order.filter((k) => byFlag.has(k)), ...[...byFlag.keys()].filter((k) => !order.includes(k))];
  for (const k of flagKeys) {
    const items = byFlag.get(k)!;
    lines.push(`### ${k} (${items.length})`);
    lines.push('');
    lines.push('| id | question | detail |');
    lines.push('|---|---|---|');
    for (const it of items) {
      const qshort = it.question.length > 70 ? it.question.slice(0, 67) + '…' : it.question;
      lines.push(`| ${it.id} | ${qshort.replace(/\|/g, '\\|')} | ${it.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  writeFileSync(join(OUT_DIR, '_draft-report.md'), lines.join('\n'));

  // Console summary
  console.log(`processed ${f1.length} formula_1 records`);
  console.log(`  → _f1-draft.jsonl: ${draftRows.length} non-cumulative draft items`);
  console.log(`  → _cumulative-candidates.jsonl: ${cumulativeRows.length} cumulative candidates`);
  console.log('stratum (non-cumulative):', JSON.stringify(stratumCount));
  console.log('flag counts:', JSON.stringify(Object.fromEntries([...byFlag].map(([k, v]) => [k, v.length]))));
}

main().catch((e) => { console.error(e); process.exit(1); });
