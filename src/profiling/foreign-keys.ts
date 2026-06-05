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
import { predicateFromColumn } from '../agent/nodes/03-relationship-link.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const key2 = (a: string, b: string): string => `${a} ${b}`;

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

/** Name overlap between a source column and its target table, in [0,1]. */
export function nameSimilarity(sourceColumn: string, targetTable: string): number {
  const base = predicateFromColumn(sourceColumn).toLowerCase(); // customer_id -> customer
  if (!base) return 0;
  const tbl = targetTable.toLowerCase();
  const singular = tbl.replace(/s$/, '');
  if (base === tbl || base === singular || `${base}s` === tbl) return 1;
  if (tbl.includes(base) || base.includes(singular)) return 0.7;
  return 0;
}

/** Target is always a key; the source's uniqueness decides 1:1 vs 1:N. */
export function inferCardinality(sourceProfile: ColumnProfile): 'one-to-one' | 'one-to-many' {
  return sourceProfile.uniquenessRatio === 1 ? 'one-to-one' : 'one-to-many';
}

export interface FkSignals {
  nameSimilarity: number;
  surrogate: boolean;
  rhsReferences: number;
}

/** FK-likelihood score in [0,1]: name boosts, popular RHS boosts, surrogate penalises. */
export function scoreForeignKey(s: FkSignals): number {
  let score = 0.5 + 0.4 * s.nameSimilarity;
  if (s.rhsReferences >= 2) score += 0.1;
  if (s.surrogate && s.nameSimilarity < 0.5) score -= 0.4; // surrogate-key coincidence
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
  for (const k of keys) {
    if (k.columns.length === 1 && k.unique) singleKeyCols.add(key2(k.table, k.columns[0] as string));
  }

  // Declared FK constraints, for the discovered-vs-declared cross-check.
  const declaredSet = new Set<string>();
  for (const fk of schema.foreignKeys) {
    declaredSet.add([fk.sourceTable, fk.sourceColumn, fk.targetTable, fk.targetColumn].join(' '));
  }

  // Step 4 — verify; keep the pairs whose IND holds.
  const verified: Array<{ pair: CandidatePair; ratio: number }> = [];
  for (const pair of pairs) {
    const r = await verifyInclusion(q, pair);
    if (r.holds) verified.push({ pair, ratio: r.containmentRatio });
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
        score: scoreForeignKey({ nameSimilarity: sim, surrogate, rhsReferences }),
        declared: declaredSet.has(
          [pair.sourceTable, pair.sourceColumn, pair.targetTable, pair.targetColumn].join(' '),
        ),
        signals: { nameSimilarity: sim, surrogate, rhsReferences },
      }),
    );
  }

  return [...unaryFks, ...detectManyToMany(unaryFks, keys)];
}
