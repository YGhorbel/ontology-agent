/**
 * SQL AST helpers for the eval harness, built on `pgsql-ast-parser` — the SAME
 * pure-TypeScript parser the formula validator uses (src/validation/formula-validator.ts),
 * reused here so join-path extraction and order-sensitivity are decided by a real
 * grammar, not regex.
 *
 * Two consumers:
 *   - the runner asks `goldHasTopLevelOrderBy` to derive `orderMatters` from the gold,
 *   - metrics asks `extractJoinPairs` for join-path precision/recall.
 */
import { parse } from 'pgsql-ast-parser';
import { normalize } from '../../src/query/text-normalize.js';

/** Parse SQL to AST statements; null on syntax error (caller decides the safe default). */
export function parseSql(sql: string): unknown[] | null {
  try {
    return parse(sql) as unknown[];
  } catch {
    return null;
  }
}

/**
 * True iff the gold's OUTERMOST select carries an `ORDER BY`. This is how the runner
 * derives `orderMatters`: a top-level ORDER BY means the row sequence is semantically
 * meaningful, so the matcher compares ordered; otherwise it compares as a set (BIRD's
 * order-insensitive default). ORDER BY inside a subquery does NOT make the final result
 * ordered, so only the top statement's `orderBy` counts.
 *
 * Conservative default: if the gold does not parse, returns false (set comparison) —
 * the BIRD default — rather than guessing order matters.
 */
export function goldHasTopLevelOrderBy(sql: string): boolean {
  const ast = parseSql(sql);
  if (!ast || ast.length === 0) return false;
  const top = ast[0];
  if (top === null || typeof top !== 'object') return false;
  const stmt = top as Record<string, unknown>;
  const orderBy = stmt['orderBy'];
  return Array.isArray(orderBy) && orderBy.length > 0;
}

interface QualRef {
  table: string;
  column: string;
}

/** Is this AST node a qualified column reference (`alias.col`)? Returns it, else null. */
function asQualifiedRef(node: unknown): QualRef | null {
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (obj['type'] !== 'ref' || typeof obj['name'] !== 'string') return null;
  const table = obj['table'] as { name?: string } | undefined;
  if (!table?.name) return null;
  return { table: table.name, column: obj['name'] };
}

/**
 * Build an alias→table map from every `{ type:'table', name:{ name, alias } }` node
 * anywhere in the AST (covers FROM and JOIN targets). Unaliased tables map to
 * themselves. Keys/values are normalized so resolution is case/quote-insensitive.
 */
function collectAliases(node: unknown, out: Map<string, string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectAliases(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'table') {
    const name = obj['name'] as { name?: string; alias?: string } | undefined;
    if (name?.name) {
      const real = normalize(name.name);
      out.set(real, real);
      if (name.alias) out.set(normalize(name.alias), real);
    }
  }
  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    collectAliases(obj[key], out);
  }
}

/**
 * Collect every equality predicate `a.x = b.y` between two QUALIFIED columns from
 * different tables, anywhere in the AST. This deliberately captures both explicit
 * `JOIN ... ON` predicates and WHERE-clause join predicates (`WHERE a.x = b.y`) —
 * both express the same join edge, and a generated query may phrase it either way.
 */
function collectJoinEqualities(node: unknown, out: Array<[QualRef, QualRef]>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectJoinEqualities(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'binary' && obj['op'] === '=') {
    const l = asQualifiedRef(obj['left']);
    const r = asQualifiedRef(obj['right']);
    if (l && r) out.push([l, r]);
  }
  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    collectJoinEqualities(obj[key], out);
  }
}

/**
 * The set of join column-pairs in a query, as canonical `table.col=table.col` strings:
 * table aliases resolved to real tables, identifiers normalized, and the two sides
 * SORTED so `a.x=b.y` and `b.y=a.x` are the same edge. Self-equalities (same
 * table.column on both sides) are dropped.
 *
 * Returns an empty set for a query with no joins, or one that does not parse.
 * Gold-vs-gold this is exact by construction (validated in metrics tests).
 */
export function extractJoinPairs(sql: string): Set<string> {
  const ast = parseSql(sql);
  const pairs = new Set<string>();
  if (!ast) return pairs;

  const aliases = new Map<string, string>();
  collectAliases(ast, aliases);
  const resolve = (t: string): string => aliases.get(normalize(t)) ?? normalize(t);

  const eqs: Array<[QualRef, QualRef]> = [];
  collectJoinEqualities(ast, eqs);

  for (const [l, r] of eqs) {
    const a = `${resolve(l.table)}.${normalize(l.column)}`;
    const b = `${resolve(r.table)}.${normalize(r.column)}`;
    if (a === b) continue; // not a join edge
    const [lo, hi] = a < b ? [a, b] : [b, a];
    pairs.add(`${lo}=${hi}`);
  }
  return pairs;
}
