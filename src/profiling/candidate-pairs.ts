/**
 * Candidate generation + statistical prefilter (deterministic, no SQL).
 *
 * Forms (source → target) column pairs and cheaply discards the ones that
 * *cannot* be an inclusion dependency (A ⊆ B), so the expensive value-containment
 * scan (Step 4) only runs on survivors. See Abedjan, Golab & Naumann, "Profiling
 * relational data: a survey" (VLDB Journal 2015), §5.3.
 *
 * The target side (B) is a Step-2 single-column key — a foreign key's RHS is a
 * key (§5.3.5). Sources (A) are all columns; same-table pairs are kept so
 * self-references (e.g. manager_id → id) are found.
 *
 * The three prefilters are *necessary conditions* for A ⊆ B, all from Step-1 stats:
 *   - type-compatible            (incompatible types cannot contain one another)
 *   - distinct(A) ≤ distinct(B)  (A has no more distinct values than B)
 *   - [min(A),max(A)] ⊆ [min(B),max(B)]   (A's range sits inside B's)
 *
 * A pair is dropped only when *provably* impossible; missing stats never prune.
 * Pure functions over Step-1 `ColumnProfile[]` and Step-2 `KeyCandidate[]`.
 */
import type { ColumnProfile } from '../types/column-profile.js';
import type { KeyCandidate } from '../types/key-candidate.js';
import { CandidatePairSchema, type CandidatePair } from '../types/candidate-pair.js';

export type TypeFamily = 'numeric' | 'text' | 'temporal' | 'uuid' | 'boolean' | 'other';

const NUMERIC = new Set([
  'smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision', 'money',
]);
const TEXT = new Set(['text', 'character varying', 'character']);
const TEMPORAL = new Set([
  'date',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
]);

/** Group an information_schema data_type into a comparable family. */
export function typeFamily(type: string): TypeFamily {
  if (NUMERIC.has(type)) return 'numeric';
  if (TEXT.has(type)) return 'text';
  if (TEMPORAL.has(type)) return 'temporal';
  if (type === 'uuid') return 'uuid';
  if (type === 'boolean') return 'boolean';
  return 'other';
}

/**
 * Compare two `::text`-encoded values within a family. Numeric values are parsed;
 * everything else compares lexicographically (correct for ISO timestamps, uuid,
 * boolean). Returns <0, 0, >0.
 */
export function compareByFamily(a: string, b: string, family: TypeFamily): number {
  if (family === 'numeric') return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PrefilterVerdict {
  keep: boolean;
  /** Why the pair was dropped (only present when keep === false). */
  reason?: 'same-column' | 'source-empty-or-allnull' | 'type-incompatible' | 'distinct-exceeds' | 'range-outside';
}

/**
 * The cheap necessary-condition test for source ⊆ target. Drops a pair only when
 * it is *provably* impossible; if a needed stat is missing it does not prune.
 */
export function prefilterPair(source: ColumnProfile, target: ColumnProfile): PrefilterVerdict {
  if (source.table === target.table && source.column === target.column) {
    return { keep: false, reason: 'same-column' };
  }
  // An empty or all-null source has no values worth relating.
  if (source.numRows === 0 || source.nullCount === source.numRows) {
    return { keep: false, reason: 'source-empty-or-allnull' };
  }

  const family = typeFamily(source.dataType);
  if (family === 'other' || family !== typeFamily(target.dataType)) {
    return { keep: false, reason: 'type-incompatible' };
  }

  // distinct(A) ≤ distinct(B) — only prunes when both are known.
  if (
    source.distinctCount !== null &&
    target.distinctCount !== null &&
    source.distinctCount > target.distinctCount
  ) {
    return { keep: false, reason: 'distinct-exceeds' };
  }

  // [min(A),max(A)] ⊆ [min(B),max(B)] — only prunes when all four are known.
  if (source.min !== null && source.max !== null && target.min !== null && target.max !== null) {
    const belowMin = compareByFamily(source.min, target.min, family) < 0;
    const aboveMax = compareByFamily(source.max, target.max, family) > 0;
    if (belowMin || aboveMax) return { keep: false, reason: 'range-outside' };
  }

  return { keep: true };
}

export interface CandidatePairOptions {
  /** Keep same-table pairs (self-references). Default true. */
  includeSelfReferences?: boolean;
}

/**
 * Generate the surviving (source → target) candidate pairs. Targets are the
 * single-column unique keys from Step 2; sources are all profiled columns.
 */
export function generateCandidatePairs(
  profiles: ColumnProfile[],
  keys: KeyCandidate[],
  opts: CandidatePairOptions = {},
): CandidatePair[] {
  const includeSelf = opts.includeSelfReferences ?? true;

  const profileByCol = new Map<string, ColumnProfile>();
  for (const p of profiles) profileByCol.set(`${p.table} ${p.column}`, p);

  // Targets: single-column unique keys, resolved to their column profile.
  const targets: ColumnProfile[] = [];
  for (const k of keys) {
    if (k.columns.length !== 1 || !k.unique) continue;
    const tp = profileByCol.get(`${k.table} ${k.columns[0]}`);
    if (tp) targets.push(tp);
  }

  const pairs: CandidatePair[] = [];
  for (const source of profiles) {
    for (const target of targets) {
      const selfTable = source.table === target.table;
      if (selfTable && !includeSelf) continue;
      if (!prefilterPair(source, target).keep) continue;

      pairs.push(
        CandidatePairSchema.parse({
          sourceTable: source.table,
          sourceColumn: source.column,
          targetTable: target.table,
          targetColumn: target.column,
          typeFamily: typeFamily(source.dataType),
          sourceDistinct: source.distinctCount,
          targetDistinct: target.distinctCount,
          selfReference: selfTable,
        }),
      );
    }
  }
  return pairs;
}
