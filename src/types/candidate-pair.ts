/**
 * Candidate pair: a (source → target) column pair that survived the cheap
 * statistical prefilter and is therefore worth testing for an inclusion
 * dependency (A ⊆ B) — the precursor to a foreign key.
 *
 * Grounded in Abedjan, Golab & Naumann, "Profiling relational data: a survey"
 * (VLDB Journal 2015), §5.3: an inclusion dependency A ⊆ B holds when every value
 * of source column A appears in target column B; a foreign key must satisfy such
 * an IND, and its target (RHS) is a key (§5.3.5). Step 3 generates these pairs and
 * prunes the *provably impossible* ones using Step-1 stats, so the expensive
 * containment scan (Step 4) only runs on survivors. zod is the source of truth.
 *
 * Produced by `src/profiling/candidate-pairs.ts`; not wired into the agent graph.
 */
import { z } from 'zod';

export const CandidatePairSchema = z.object({
  sourceTable: z.string(),
  sourceColumn: z.string(),
  targetTable: z.string(),
  /** A single-column key (the relationship RHS / FK target). */
  targetColumn: z.string(),
  /** The shared type family that passed the compatibility check. */
  typeFamily: z.string(),
  /** distinct(source) — carried for downstream ranking; null if unmeasured. */
  sourceDistinct: z.number().int().nonnegative().nullable(),
  /** distinct(target) — by construction ≥ sourceDistinct when both known. */
  targetDistinct: z.number().int().nonnegative().nullable(),
  /** sourceTable === targetTable (a self-reference, e.g. manager_id → id). */
  selfReference: z.boolean(),
  /**
   * Name overlap between source column and target table, in [0,1] (see
   * `nameSimilarity`). Computed once at generation; a strong match both relaxes the
   * statistical prefilter and lets the FK step recover an edge when the IND falls short.
   */
  nameSimilarity: z.number().min(0).max(1).default(0),
});
export type CandidatePair = z.infer<typeof CandidatePairSchema>;
