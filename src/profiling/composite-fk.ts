/**
 * Bounded composite (2-column) foreign-key discovery (Fix 7) — deterministic, runs once in 1b.
 *
 * Some joins need two keys at once: laptimes(raceid, driverid) → results(raceid, driverid).
 * The ontology has each *unary* FK (raceid→races, driverid→drivers) but no direct path between
 * the two fact tables, so a "lap time per constructor" query has to detour through a shared
 * dimension and silently fan out. This recovers the direct composite edge.
 *
 * Strictly bounded (NOT general n-ary discovery):
 *   - only **table pairs that already share ≥2 unary FKs** pointing at the same targets,
 *   - only **2-column** combinations of those shared keys,
 *   - the target side's pair must be an (approximate) key — we pick the more-unique side as the
 *     parent and require its distinct/total ratio ≥ `KEY_MIN_UNIQUENESS`,
 *   - skip a table whose row count exceeds `ONTOLOGY_COMPOSITE_MAX_ROWS`,
 *   - verify the 2-column inclusion dependency with one containment scan (`ONTOLOGY_IND_MIN_CONTAINMENT`).
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { ForeignKeyCandidate, CompositeForeignKeyCandidate } from '../types/foreign-key-candidate.js';

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** A near-unique pair (this fraction distinct) is treated as an approximate key on the target side. */
const KEY_MIN_UNIQUENESS = 0.99;

const indMinContainment = (): number => {
  const raw = Number(process.env.ONTOLOGY_IND_MIN_CONTAINMENT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
};
const compositeMaxRowsFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_COMPOSITE_MAX_ROWS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5_000_000;
};
const stmtTimeoutMs = (): number => {
  const raw = Number(process.env.ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
};

/** table -> (targetTable -> sourceColumn): the FK columns from a table, declared ∪ discovered. */
function fkTargetsByTable(schema: CanonicalSchema, fks: ForeignKeyCandidate[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const put = (src: string, target: string, col: string): void => {
    const m = out.get(src) ?? new Map<string, string>();
    if (!m.has(target)) m.set(target, col); // first (declared) wins
    out.set(src, m);
  };
  for (const fk of schema.foreignKeys) put(fk.sourceTable, fk.targetTable, fk.sourceColumn);
  for (const fk of fks) if (fk.kind === 'foreign-key' && fk.sourceColumn && fk.targetTable) put(fk.sourceTable, fk.targetTable, fk.sourceColumn);
  return out;
}

export function buildPairUniquenessQuery(table: string, c1: string, c2: string): string {
  return (
    `SELECT count(*) AS n, count(DISTINCT (${quoteIdent(c1)}, ${quoteIdent(c2)})) AS d ` +
    `FROM ${quoteIdent(table)} WHERE ${quoteIdent(c1)} IS NOT NULL AND ${quoteIdent(c2)} IS NOT NULL`
  );
}

export function buildCompositeContainmentQuery(
  child: string,
  childCols: [string, string],
  parent: string,
  parentCols: [string, string],
): string {
  const [a1, a2] = childCols.map(quoteIdent);
  const [b1, b2] = parentCols.map(quoteIdent);
  return (
    `SELECT count(*) AS src_distinct, count(*) FILTER (WHERE t.k1 IS NULL) AS missing FROM (` +
    `SELECT DISTINCT ${a1} AS k1, ${a2} AS k2 FROM ${quoteIdent(child)} WHERE ${a1} IS NOT NULL AND ${a2} IS NOT NULL) s ` +
    `LEFT JOIN (SELECT DISTINCT ${b1} AS k1, ${b2} AS k2 FROM ${quoteIdent(parent)}) t ON t.k1 = s.k1 AND t.k2 = s.k2`
  );
}

/** All 2-combinations of a sorted list. */
function pairs<T>(xs: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < xs.length; i += 1) for (let j = i + 1; j < xs.length; j += 1) out.push([xs[i] as T, xs[j] as T]);
  return out;
}

/** Pair-uniqueness (distinct/total), memoized per (table, column-pair) — the dominant cost. */
function pairUniquenessMemo(q: Queryable): (table: string, c1: string, c2: string) => Promise<number | null> {
  const cache = new Map<string, Promise<number | null>>();
  return (table, c1, c2) => {
    const key = `${table}|${[c1, c2].slice().sort().join(',')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = q.query(buildPairUniquenessQuery(table, c1, c2)).then(({ rows }) => {
      const n = Number(rows[0]?.['n'] ?? 0);
      const d = Number(rows[0]?.['d'] ?? 0);
      return n > 0 ? d / n : null;
    });
    cache.set(key, p);
    return p;
  };
}

export async function discoverCompositeForeignKeys(
  q: Queryable,
  schema: CanonicalSchema,
  fks: ForeignKeyCandidate[],
  profiles: ColumnProfile[],
): Promise<CompositeForeignKeyCandidate[]> {
  const targets = fkTargetsByTable(schema, fks);
  const rowsByTable = new Map<string, number>();
  for (const p of profiles) rowsByTable.set(p.table, Math.max(rowsByTable.get(p.table) ?? 0, p.numRows));

  const maxRows = compositeMaxRowsFromEnv();
  const minContainment = indMinContainment();
  const best = new Map<string, CompositeForeignKeyCandidate>();

  await q.query(`SET LOCAL statement_timeout = ${stmtTimeoutMs()}`).catch(() => undefined);
  const pairUniqueness = pairUniquenessMemo(q);

  const tables = [...targets.keys()].sort();
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const X = tables[i] as string;
      const Y = tables[j] as string;
      if ((rowsByTable.get(X) ?? 0) > maxRows || (rowsByTable.get(Y) ?? 0) > maxRows) continue;
      const xm = targets.get(X) as Map<string, string>;
      const ym = targets.get(Y) as Map<string, string>;
      const shared = [...xm.keys()].filter((t) => ym.has(t)).sort();
      if (shared.length < 2) continue;

      for (const [t1, t2] of pairs(shared)) {
        const xCols: [string, string] = [xm.get(t1) as string, xm.get(t2) as string];
        const yCols: [string, string] = [ym.get(t1) as string, ym.get(t2) as string];
        try {
          const xu = await pairUniqueness(X, xCols[0], xCols[1]);
          const yu = await pairUniqueness(Y, yCols[0], yCols[1]);
          if (xu === null || yu === null) continue;
          // Parent = the more-unique side; it must be an approximate key.
          const parentIsY = yu >= xu;
          const parentU = parentIsY ? yu : xu;
          if (parentU < KEY_MIN_UNIQUENESS) continue;
          const child = parentIsY ? X : Y;
          const childCols = parentIsY ? xCols : yCols;
          const parent = parentIsY ? Y : X;
          const parentCols = parentIsY ? yCols : xCols;

          const { rows } = await q.query(buildCompositeContainmentQuery(child, childCols, parent, parentCols));
          const srcDistinct = Number(rows[0]?.['src_distinct'] ?? 0);
          const missing = Number(rows[0]?.['missing'] ?? 0);
          if (srcDistinct <= 0) continue;
          const containment = (srcDistinct - missing) / srcDistinct;
          if (containment < minContainment) continue;

          // One composite edge per child→parent direction (the @id is direction-keyed): when
          // several 2-combos qualify, keep the highest-scoring one.
          const dirKey = `${child}|${parent}`;
          const score = Math.min(containment, parentU);
          const prev = best.get(dirKey);
          if (!prev || score > prev.score) {
            best.set(dirKey, {
              sourceTable: child,
              sourceColumns: childCols,
              targetTable: parent,
              targetColumns: parentCols,
              containmentRatio: containment,
              targetUniqueness: parentU,
              score,
            });
          }
        } catch {
          // A probe failure (timeout / type mismatch) is non-fatal: skip this pair.
        }
      }
    }
  }
  return [...best.values()];
}
