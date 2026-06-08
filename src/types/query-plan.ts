/**
 * Query-planning types: the join graph extracted from the ontology and the
 * resolved JOIN path for a set of tables.
 *
 * These drive the SQL-compilation half of the system (the ontology is the
 * semantic layer; this is how we read it to build queries). zod is the source of
 * truth; `z.infer` gives the TS types.
 */
import { z } from 'zod';

const Cardinality = z.enum(['one-to-one', 'one-to-many', 'many-to-many']);
const Provenance = z.enum(['declared', 'discovered', 'inferred-name']);

/** A directed, joinable relationship between two tables, with its literal keys. */
export const JoinEdgeSchema = z.object({
  fromTable: z.string(),
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
  cardinality: Cardinality,
  /** FK-likelihood in [0,1]; 1 for declared constraints. Used as 1/confidence edge weight. */
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
});
export type JoinEdge = z.infer<typeof JoinEdgeSchema>;

/** One resolved `JOIN <joinTable> ON <left> = <right>` clause. left/right are "table.column". */
export const JoinClauseSchema = z.object({
  joinTable: z.string(),
  on: z.object({ left: z.string(), right: z.string() }),
  cardinality: Cardinality,
  /** Trust of this hop: 1 for declared FKs, the FK score for discovered ones. */
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
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
});
export type JoinPath = z.infer<typeof JoinPathSchema>;
