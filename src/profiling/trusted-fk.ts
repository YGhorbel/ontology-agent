/**
 * Trusted unary foreign keys (shared profiling helper, deterministic).
 *
 * Several downstream steps must reason over only the FKs they should *trust* — not
 * every promiscuous inclusion dependency the discoverer surfaces. A column whose
 * integer values happen to be contained in another column's (position ⊆ constructorid,
 * stop ⊆ statusid) forms a verified IND but is NOT a real foreign key; admitting those
 * coincidences as edges is what poisoned composite-FK discovery (Fix 7) and the
 * monotonicity partition (Part 2a).
 *
 * A unary FK is "trusted" iff it is:
 *   - a declared catalog FK constraint (always authoritative), OR
 *   - a discovered `foreign-key` candidate recovered by a strong column-name match
 *     (`evidence === 'name'` → published as an inferred-name edge), OR
 *   - a discovered `foreign-key` candidate whose FK-likelihood score clears the same
 *     bar the asserted graph uses (`ONTOLOGY_EXPORT_MIN_CONF`, default 0.5).
 *
 * Low-confidence (≤0.05) value-overlap candidates and N:M/self-reference kinds are
 * excluded. This is the exact "trusted unary edge" notion Fix 7's preconditions need.
 */
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ForeignKeyCandidate } from '../types/foreign-key-candidate.js';

export interface TrustedUnaryFk {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

/** Min FK-likelihood for a discovered (non-name) edge to count as trusted. Mirrors the asserted-graph bar. */
export const trustedFkMinConfFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_EXPORT_MIN_CONF);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
};

const tupleKey = (f: TrustedUnaryFk): string => `${f.sourceTable}|${f.sourceColumn}|${f.targetTable}|${f.targetColumn}`;

/**
 * Declared FKs ∪ trusted discovered unary FKs, deduplicated by endpoint 4-tuple
 * (declared wins). Only `kind === 'foreign-key'` candidates with both endpoint
 * columns are considered; self-references and N:M aggregates are out of scope.
 */
export function trustedUnaryFks(
  schema: CanonicalSchema,
  fks: ForeignKeyCandidate[],
  minConf: number = trustedFkMinConfFromEnv(),
): TrustedUnaryFk[] {
  const out = new Map<string, TrustedUnaryFk>();
  for (const fk of schema.foreignKeys) {
    const t: TrustedUnaryFk = {
      sourceTable: fk.sourceTable,
      sourceColumn: fk.sourceColumn,
      targetTable: fk.targetTable,
      targetColumn: fk.targetColumn,
    };
    out.set(tupleKey(t), t);
  }
  for (const fk of fks) {
    if (fk.kind !== 'foreign-key' || !fk.sourceColumn || !fk.targetColumn) continue;
    const isTrusted = fk.declared || fk.evidence === 'name' || fk.score >= minConf;
    if (!isTrusted) continue;
    const t: TrustedUnaryFk = {
      sourceTable: fk.sourceTable,
      sourceColumn: fk.sourceColumn,
      targetTable: fk.targetTable,
      targetColumn: fk.targetColumn,
    };
    if (!out.has(tupleKey(t))) out.set(tupleKey(t), t);
  }
  return [...out.values()];
}
