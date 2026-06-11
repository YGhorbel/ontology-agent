/**
 * Query-planning types: the join graph extracted from the ontology and the
 * resolved JOIN path for a set of tables.
 *
 * These drive the SQL-compilation half of the system (the ontology is the
 * semantic layer; this is how we read it to build queries). zod is the source of
 * truth; `z.infer` gives the TS types.
 */
import { z } from 'zod';

const Cardinality = z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']);
const Provenance = z.enum(['declared', 'discovered', 'inferred-name', 'co-reference']);

/**
 * A directed, joinable relationship between two tables, with its literal keys.
 * `fromColumn`/`toColumn` are the primary join key; `extraColumns` carries the 2nd+
 * key pairs for a *composite* join (e.g. a co-reference edge on raceid AND driverid),
 * empty for an ordinary single-column FK.
 */
export const JoinEdgeSchema = z.object({
  fromTable: z.string(),
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
  /** Additional key pairs for a composite/co-reference join (empty for single-column FKs). */
  extraColumns: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  cardinality: Cardinality,
  /** FK-likelihood in [0,1]; 1 for declared constraints. Used as 1/confidence edge weight. */
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
});
export type JoinEdge = z.infer<typeof JoinEdgeSchema>;

/**
 * One resolved `JOIN <joinTable> ON ...` clause. `on` is the list of equalities (≥1);
 * a single-column FK has one, a composite/co-reference join has several joined by AND.
 * left/right are "table.column".
 */
export const JoinClauseSchema = z.object({
  joinTable: z.string(),
  on: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
  cardinality: Cardinality,
  /** Trust of this hop: 1 for declared FKs, the FK score for discovered ones. */
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
  /** True when this hop can multiply rows (one-to-many / many-to-many) → aggregates may double-count. */
  multiplies: z.boolean().default(false),
});
export type JoinClause = z.infer<typeof JoinClauseSchema>;

/** The connected join plan for a set of requested tables. */
export const JoinPathSchema = z.object({
  /** The FROM table the JOINs chain off. */
  anchorTable: z.string(),
  clauses: z.array(JoinClauseSchema),
  /** Requested tables that could not be connected to the anchor. */
  unreachable: z.array(z.string()),
  /** True when the path relies on a below-floor (discovered) edge — a best-effort fallback. */
  lowConfidence: z.boolean(),
  /** True when any clause multiplies rows — a measure over this path may need DISTINCT/subquery. */
  fanOut: z.boolean().default(false),
});
export type JoinPath = z.infer<typeof JoinPathSchema>;

/**
 * One scored candidate among the K-best paths between two tables — the payload a
 * downstream LLM ranks to pick the semantically correct join for a question.
 */
export const JoinPathCandidateSchema = z.object({
  path: JoinPathSchema,
  /** Composite rank score (higher = better): confidence up, hops down, fan-out penalised. */
  score: z.number(),
  /** Product of the per-hop confidences in [0,1]. */
  totalConfidence: z.number().min(0).max(1),
  hops: z.number().int().nonnegative(),
  fanOut: z.boolean(),
  /** True when any hop is a below-floor (low-confidence) edge. */
  usesLowConfidence: z.boolean(),
  /** The distinct provenances used across the path (e.g. ["declared","co-reference"]). */
  provenanceMix: z.array(z.string()),
});
export type JoinPathCandidate = z.infer<typeof JoinPathCandidateSchema>;
