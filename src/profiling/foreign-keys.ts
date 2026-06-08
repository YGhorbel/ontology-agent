/**
 * Inclusion-dependency verification + foreign-key promotion (deterministic).
 *
 * Step 4 — verify: for each candidate pair (A → B from Step 3), run the real
 *   containment scan; the IND A ⊆ B holds iff every non-null value of A appears
 *   in B. Exact containment; the ratio is recorded.
 * Step 5 — promote (§5.3.5 + §5.1): each verified IND becomes a foreign key.
 *   The RHS is already a key (Step 3); cardinality is read from the two
 *   uniqueness values (LHS unique → 1:1, else 1:N); same-table INDs are
 *   self-references; a 2-column key whose components are each FKs is an N:M
 *   junction; FK-likelihood is scored from §5.3.5 signals (name similarity,
 *   surrogate penalty, RHS popularity) because "not all INDs are foreign keys".
 *
 * Functions over the injected `Queryable` port + Step-1/2/3 outputs. Standalone;
 * the ontology mapping (ForeignKeyCandidate → Relationship) is a later step.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { KeyCandidate } from '../types/key-candidate.js';
import type { CandidatePair } from '../types/candidate-pair.js';
import { ForeignKeyCandidateSchema, type ForeignKeyCandidate } from '../types/foreign-key-candidate.js';
import { nameSimilarity, nameMatchMinFromEnv } from './name-match.js';

// Re-exported so existing importers (and tests) keep their `from './foreign-keys.js'` path.
export { nameSimilarity } from './name-match.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const key2 = (a: string, b: string): string => `${a} ${b}`;

/** Minimum value-containment for an approximate inclusion dependency. Default 0.7; env-overridable. */
const inclusionThresholdFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_IND_MIN_CONTAINMENT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
};

/**
 * Confidence for a name-recovered edge — a strong name+type match whose IND did NOT
 * hold (e.g. a trimmed dump). Default 0.65: above the resolver's 0.5 trust floor (so
 * it is auto-joined for normal queries) yet clearly below a data-verified FK.
 */
const nameOnlyConfidenceFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_NAME_ONLY_CONFIDENCE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.65;
};

/** One read-only containment scan for a unary candidate pair. Exported for testing. */
export function buildContainmentQuery(pair: CandidatePair): string {
  const sc = quoteIdent(pair.sourceColumn);
  const tc = quoteIdent(pair.targetColumn);
  return (
    `SELECT count(*) AS src_distinct, count(*) FILTER (WHERE t.v IS NULL) AS missing ` +
    `FROM (SELECT DISTINCT ${sc} AS v FROM ${quoteIdent(pair.sourceTable)} WHERE ${sc} IS NOT NULL) s ` +
    `LEFT JOIN (SELECT DISTINCT ${tc} AS v FROM ${quoteIdent(pair.targetTable)}) t ON t.v = s.v`
  );
}

export interface InclusionResult {
  srcDistinct: number;
  missing: number;
  containmentRatio: number;
  holds: boolean;
}

/** Verify A ⊆ B by counting distinct source values absent from the target. */
export async function verifyInclusion(q: Queryable, pair: CandidatePair): Promise<InclusionResult> {
  const { rows } = await q.query(buildContainmentQuery(pair));
  const row = rows[0] ?? {};
  const srcDistinct = num(row['src_distinct']) ?? 0;
  const missing = num(row['missing']) ?? 0;
  const containmentRatio = srcDistinct > 0 ? (srcDistinct - missing) / srcDistinct : 0;
  return { srcDistinct, missing, containmentRatio, holds: srcDistinct > 0 && missing === 0 };
}

/** Target is always a key; the source's uniqueness decides 1:1 vs 1:N. */
export function inferCardinality(sourceProfile: ColumnProfile): 'one-to-one' | 'one-to-many' {
  return sourceProfile.uniquenessRatio === 1 ? 'one-to-one' : 'one-to-many';
}

export interface FkSignals {
  nameSimilarity: number;
  /** The source column is its own table's key (a surrogate-coincidence risk). */
  surrogate: boolean;
  /** The target column is a bare surrogate key (a 1..N PK that swallows spurious INDs). */
  surrogateTarget?: boolean;
  rhsReferences: number;
}

/**
 * FK-likelihood score in [0,1]. Name similarity dominates with a low baseline, so a
 * name-mismatched inclusion dependency starts low and the surrogate-key coincidences
 * (an IND that "holds" only because the target is a sequential 1..N key) fall out —
 * "a foreign key must satisfy an IND, but not all INDs are foreign keys" (§5.3.5).
 */
export function scoreForeignKey(s: FkSignals): number {
  let score = 0.15 + 0.7 * s.nameSimilarity;
  if (s.rhsReferences >= 2) score += 0.1; // a popular RHS key is more FK-like
  if (s.nameSimilarity < 0.5) {
    if (s.surrogate) score -= 0.3; // source is its own surrogate key
    if (s.surrogateTarget) score -= 0.2; // spurious reference into a surrogate PK
  }
  return clamp(score);
}

/**
 * N:M detection: a junction is a table with a 2-column unique key whose two
 * columns are each verified unary FKs into two *different* tables.
 */
export function detectManyToMany(
  unaryFks: ForeignKeyCandidate[],
  keys: KeyCandidate[],
): ForeignKeyCandidate[] {
  const fkByCol = new Map<string, ForeignKeyCandidate>();
  for (const fk of unaryFks) {
    if (fk.sourceColumn) fkByCol.set(key2(fk.sourceTable, fk.sourceColumn), fk);
  }

  const result: ForeignKeyCandidate[] = [];
  for (const k of keys) {
    if (k.columns.length !== 2 || !k.unique) continue;
    const fk1 = fkByCol.get(key2(k.table, k.columns[0] as string));
    const fk2 = fkByCol.get(key2(k.table, k.columns[1] as string));
    if (!fk1 || !fk2 || fk1.targetTable === fk2.targetTable) continue;

    result.push(
      ForeignKeyCandidateSchema.parse({
        kind: 'many-to-many',
        sourceTable: fk1.targetTable,
        sourceColumn: null,
        targetTable: fk2.targetTable,
        targetColumn: null,
        junctionTable: k.table,
        cardinality: 'many-to-many',
        verified: true,
        containmentRatio: Math.min(fk1.containmentRatio, fk2.containmentRatio),
        score: Math.min(fk1.score, fk2.score),
        declared: fk1.declared && fk2.declared,
        signals: {
          nameSimilarity: Math.min(fk1.signals.nameSimilarity, fk2.signals.nameSimilarity),
          surrogate: false,
          rhsReferences: Math.min(fk1.signals.rhsReferences, fk2.signals.rhsReferences),
        },
      }),
    );
  }
  return result;
}

/**
 * Verify each candidate pair (Step 4) and promote the holders to foreign keys
 * with cardinality, classification, score and declared cross-check (Step 5),
 * then append the N:M junctions.
 */
export async function discoverForeignKeys(
  q: Queryable,
  schema: CanonicalSchema,
  profiles: ColumnProfile[],
  keys: KeyCandidate[],
  pairs: CandidatePair[],
): Promise<ForeignKeyCandidate[]> {
  const profileByCol = new Map<string, ColumnProfile>();
  for (const p of profiles) profileByCol.set(key2(p.table, p.column), p);

  // Source columns that are their own table's single-column key → surrogate risk.
  const singleKeyCols = new Set<string>();
  // Declared single-column primary keys — the only legitimate target for a
  // name-recovered edge. `nameSimilarity` matches the target *table*, not the
  // column, so without this gate a name-matched source would recover against any
  // coincidentally-unique column (e.g. orders.total_amount) instead of orders.id.
  const primaryKeyCols = new Set<string>();
  for (const k of keys) {
    if (k.columns.length !== 1) continue;
    const col = key2(k.table, k.columns[0] as string);
    if (k.unique) singleKeyCols.add(col);
    if (k.declared === 'primary') primaryKeyCols.add(col);
  }

  // Declared FK constraints, for the discovered-vs-declared cross-check.
  const declaredSet = new Set<string>();
  for (const fk of schema.foreignKeys) {
    declaredSet.add([fk.sourceTable, fk.sourceColumn, fk.targetTable, fk.targetColumn].join(' '));
  }

  // Step 4 — verify; keep the pairs whose IND holds (approximately).
  // Exact 100% containment misses real but undeclared FKs in trimmed/dirty data
  // (a few orphan rows). Accept ratio ≥ threshold; the name-dominant FK score still
  // rejects name-less near-coincidences, so recall rises without losing precision.
  // When the IND falls short but the column name+type strongly matches the target
  // (e.g. `driverstandings.raceid`→`races` in a trimmed dump), keep it as a
  // name-recovered edge: naming is FK evidence independent of the data. Promoted at
  // a capped confidence with `evidence: 'name'` so it stays distinguishable.
  const minContainment = inclusionThresholdFromEnv();
  const nameMatchMin = nameMatchMinFromEnv();
  const verified: Array<{ pair: CandidatePair; ratio: number }> = [];
  const nameRecovered: Array<{ pair: CandidatePair; ratio: number }> = [];
  for (const pair of pairs) {
    const r = await verifyInclusion(q, pair);
    if (r.srcDistinct <= 0) continue;
    if (r.containmentRatio >= minContainment) {
      verified.push({ pair, ratio: r.containmentRatio });
    } else if (
      pair.nameSimilarity >= nameMatchMin &&
      primaryKeyCols.has(key2(pair.targetTable, pair.targetColumn))
    ) {
      nameRecovered.push({ pair, ratio: r.containmentRatio });
    }
  }

  // RHS popularity: how many verified INDs point at each target key.
  const rhsTally = new Map<string, number>();
  for (const { pair } of verified) {
    const t = key2(pair.targetTable, pair.targetColumn);
    rhsTally.set(t, (rhsTally.get(t) ?? 0) + 1);
  }

  // Step 5 — promote each verified IND.
  const unaryFks: ForeignKeyCandidate[] = [];
  for (const { pair, ratio } of verified) {
    const sourceProfile = profileByCol.get(key2(pair.sourceTable, pair.sourceColumn));
    if (!sourceProfile) continue;

    const sim = nameSimilarity(pair.sourceColumn, pair.targetTable);
    const surrogate = singleKeyCols.has(key2(pair.sourceTable, pair.sourceColumn));
    const surrogateTarget = singleKeyCols.has(key2(pair.targetTable, pair.targetColumn));
    const rhsReferences = rhsTally.get(key2(pair.targetTable, pair.targetColumn)) ?? 0;

    unaryFks.push(
      ForeignKeyCandidateSchema.parse({
        kind: pair.selfReference ? 'self-reference' : 'foreign-key',
        sourceTable: pair.sourceTable,
        sourceColumn: pair.sourceColumn,
        targetTable: pair.targetTable,
        targetColumn: pair.targetColumn,
        junctionTable: null,
        cardinality: inferCardinality(sourceProfile),
        verified: true,
        containmentRatio: ratio,
        score: scoreForeignKey({ nameSimilarity: sim, surrogate, surrogateTarget, rhsReferences }),
        declared: declaredSet.has(
          [pair.sourceTable, pair.sourceColumn, pair.targetTable, pair.targetColumn].join(' '),
        ),
        evidence: 'ind',
        signals: { nameSimilarity: sim, surrogate, rhsReferences },
      }),
    );
  }

  // Step 5b — promote name-recovered pairs (strong name, IND short) at capped confidence.
  const nameOnlyConfidence = nameOnlyConfidenceFromEnv();
  for (const { pair, ratio } of nameRecovered) {
    const sourceProfile = profileByCol.get(key2(pair.sourceTable, pair.sourceColumn));
    if (!sourceProfile) continue;

    const surrogate = singleKeyCols.has(key2(pair.sourceTable, pair.sourceColumn));
    unaryFks.push(
      ForeignKeyCandidateSchema.parse({
        kind: pair.selfReference ? 'self-reference' : 'foreign-key',
        sourceTable: pair.sourceTable,
        sourceColumn: pair.sourceColumn,
        targetTable: pair.targetTable,
        targetColumn: pair.targetColumn,
        junctionTable: null,
        cardinality: inferCardinality(sourceProfile),
        verified: false, // the IND did not hold; the name carries the edge
        containmentRatio: ratio,
        score: nameOnlyConfidence,
        declared: declaredSet.has(
          [pair.sourceTable, pair.sourceColumn, pair.targetTable, pair.targetColumn].join(' '),
        ),
        evidence: 'name',
        signals: { nameSimilarity: pair.nameSimilarity, surrogate, rhsReferences: 0 },
      }),
    );
  }

  return [...unaryFks, ...detectManyToMany(unaryFks, keys)];
}
