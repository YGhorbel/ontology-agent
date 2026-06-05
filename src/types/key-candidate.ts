/**
 * Key candidate: a column or small column-set that is (or is declared) unique —
 * i.e. a legal *target side* (RHS) for a relationship, since a foreign key can
 * only point at a unique column-set.
 *
 * Grounded in Abedjan, Golab & Naumann, "Profiling relational data: a survey"
 * (VLDB Journal 2015), §5.1 (unique column combinations & keys). A column-set X
 * is unique iff `COUNT(DISTINCT X) == COUNT(*)`. The paper distinguishes
 * *certain* keys (no NULLs) from *possible* keys (nullable), and notes that full
 * minimal-unique discovery is NP-hard — so we stay bounded (single-column +
 * 2-column probes). zod is the source of truth; the type is inferred.
 *
 * Produced by `src/profiling/key-discovery.ts`; not wired into the agent graph.
 */
import { z } from 'zod';

export const KeyCandidateSchema = z.object({
  table: z.string(),
  /** The unique column-set: 1 column (single) or 2 (bounded composite). */
  columns: z.array(z.string()).min(1),
  numRows: z.number().int().nonnegative(),
  /** count(DISTINCT columns); null for a declared key whose data was not measured. */
  distinctCount: z.number().int().nonnegative().nullable(),
  /** distinctCount === numRows && numRows > 0 (or trusted from a declared constraint). */
  unique: z.boolean(),
  /** unique AND no NULLs in any column → a *certain* key, the valid FK target. */
  certain: z.boolean(),
  /** No proper subset is unique (single-column keys are trivially minimal). */
  minimal: z.boolean(),
  /** Matches a catalog PRIMARY KEY / UNIQUE constraint, else null (an undeclared discovery). */
  declared: z.enum(['primary', 'unique']).nullable(),
  /** How uniqueness was established. */
  method: z.enum(['single-column', 'composite-probe', 'declared']),
});
export type KeyCandidate = z.infer<typeof KeyCandidateSchema>;
