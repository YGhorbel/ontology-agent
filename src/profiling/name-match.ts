/**
 * Column-name ↔ table-name similarity (deterministic, pure).
 *
 * Naming is a foreign-key signal independent of the data: a column named after
 * its target table (`raceid`→`races`, `customer_id`→`customers`) is strong FK
 * evidence even when the value-containment (IND) test fails — e.g. a trimmed dump
 * whose target rows are partial. So this lives apart from the profiling so both
 * candidate generation (to keep a strong-name pair the data-stats would prune) and
 * FK promotion (to recover an edge the IND gate would drop) can share it.
 */
import { predicateFromColumn } from '../agent/nodes/03-relationship-link.js';

/**
 * Minimum `nameSimilarity` for a pair to count as a strong name match — the bar for
 * relaxing the candidate prefilter and for promoting a name-only (no-IND) edge.
 * Default 1.0 (exact base==table, e.g. `raceid`→`races`) so we resurrect real FKs
 * without flooding; env-overridable down toward 0.7 for more recall.
 */
export const nameMatchMinFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_NAME_MATCH_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1.0;
};

/**
 * Name overlap between a source column and its target table, in [0,1].
 *
 * Derives candidate bases from both the `X_id` convention (`customer_id`->`customer`,
 * via `predicateFromColumn`) and the no-underscore `Xid` convention
 * (`raceid`->`race`, `driverid`->`driver`) — the latter previously only scored 0.7
 * and dropped real FKs under the threshold.
 */
export function nameSimilarity(sourceColumn: string, targetTable: string): number {
  const tbl = targetTable.toLowerCase();
  const singular = tbl.replace(/s$/, '');

  const bases = new Set<string>();
  const predicate = predicateFromColumn(sourceColumn).toLowerCase(); // customer_id -> customer
  if (predicate) bases.add(predicate);
  const noId = sourceColumn.toLowerCase().replace(/id$/, ''); // raceid -> race, statusid -> status
  if (noId && noId !== sourceColumn.toLowerCase()) bases.add(noId);

  let best = 0;
  for (const base of bases) {
    if (!base) continue;
    if (base === tbl || base === singular || `${base}s` === tbl) {
      best = Math.max(best, 1);
    } else if (
      // base is most of a compound table name (constructor⊄constructorresults), or
      // the source column embeds the singular table name (driver_ref ⊇ driver).
      (tbl.includes(base) && base.length >= tbl.length * 0.7) ||
      base.includes(singular)
    ) {
      best = Math.max(best, 0.7);
    }
  }
  return best;
}
