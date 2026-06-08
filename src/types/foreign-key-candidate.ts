/**
 * Foreign-key candidate: a verified inclusion dependency promoted to a foreign
 * key, with cardinality and an FK-likelihood score.
 *
 * Grounded in Abedjan, Golab & Naumann, "Profiling relational data: a survey"
 * (VLDB Journal 2015), §5.3.5 + §5.1. An IND (A ⊆ B) is *necessary but not
 * sufficient* for a foreign key (§5.3.5): surrogate auto-increment keys form INDs
 * that aren't FKs. So each verified IND is ranked by FK-likelihood signals (name
 * similarity, surrogate penalty, RHS popularity) and assigned a cardinality read
 * from the two uniqueness values (RHS is a key; LHS unique → 1:1, else 1:N).
 * Junctions (a 2-column key whose components are each FKs) become N:M.
 *
 * Produced by `src/profiling/foreign-keys.ts`; maps onto the ontology
 * `Relationship` (which already carries a `cardinality`). zod is the source of truth.
 */
import { z } from 'zod';

export const ForeignKeyCandidateSchema = z.object({
  kind: z.enum(['foreign-key', 'self-reference', 'many-to-many']),
  sourceTable: z.string(),
  /** null for the aggregate many-to-many entry. */
  sourceColumn: z.string().nullable(),
  targetTable: z.string(),
  /** null for the aggregate many-to-many entry. */
  targetColumn: z.string().nullable(),
  /** The bridge table, set only when kind === 'many-to-many'. */
  junctionTable: z.string().nullable(),
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
  /** The inclusion dependency holds (exact containment). */
  verified: z.boolean(),
  /** Fraction of distinct source values found in the target, in [0,1]. */
  containmentRatio: z.number().min(0).max(1),
  /** FK-likelihood, in [0,1] — separates real FKs from surrogate-key coincidences. */
  score: z.number().min(0).max(1),
  /** Matches a declared catalog FK constraint (else an undeclared discovery). */
  declared: z.boolean(),
  /**
   * Which signal promoted this candidate: `'ind'` = a verified inclusion dependency
   * (data containment held); `'name'` = a strong column-name+type match whose IND did
   * not hold (recovered edge, capped confidence). Drives `provenance` downstream.
   */
  evidence: z.enum(['ind', 'name']).default('ind'),
  signals: z.object({
    /** Name overlap between the source column and the target table/column. */
    nameSimilarity: z.number().min(0).max(1),
    /** The source column is its own table's key (a surrogate-coincidence risk). */
    surrogate: z.boolean(),
    /** How many verified INDs point at this target key (PK popularity). */
    rhsReferences: z.number().int().nonnegative(),
  }),
});
export type ForeignKeyCandidate = z.infer<typeof ForeignKeyCandidateSchema>;
