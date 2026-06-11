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
import type { OntologyIndex } from './ontology-index.js';
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

/** The aggregate SELECT expression for a measure, from the capability formula when present. */
function aggregateExpr(measure: QueryIntent['measures'][number], index: OntologyIndex): string {
  const cap = index.capabilities.find(
    (c) =>
      c.kind === 'metric' &&
      c.scopeTable === measure.table &&
      c.scopeColumn === measure.column &&
      (measure.capability === undefined || c.prefLabel === measure.capability),
  );
  const expr = cap?.formulaHint ?? `SUM(${measure.table}.${measure.column})`;
  const alias = slug(cap?.prefLabel ?? measure.column);
  return `${expr} AS ${alias}`;
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
  const selectItems = [...nonAgg, ...measureExprs];
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
