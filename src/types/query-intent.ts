/**
 * Schema-linking types: the typed `QueryIntent` a natural-language question is
 * resolved to (which tables, measures, group dimensions, filter columns+values),
 * plus the per-span `LinkCandidate` payload that records how each reference matched.
 *
 * This is the front half of the query side: `linkQuestion(question, index)` produces
 * a `QueryIntent` whose `tables` feed the join resolver (`resolveAllPaths` /
 * `resolveJoinPath`). zod is the source of truth; `z.infer` gives the TS types.
 *
 * Tier-1 (deterministic) only: ambiguity is *surfaced* in `ambiguities` rather than
 * resolved by an LLM — that payload is exactly what a later disambiguation tier
 * would consume.
 */
import { z } from 'zod';

/** A reference to an ontology element: a table, or a specific column of a table. */
export const ElementRefSchema = z.object({
  table: z.string(),
  column: z.string().optional(),
});
export type ElementRef = z.infer<typeof ElementRefSchema>;

/** The job an element plays in a query. */
export const LinkRoleSchema = z.enum(['entity', 'measure', 'dimension', 'attribute']);
export type LinkRole = z.infer<typeof LinkRoleSchema>;

/** Filter operators tier-1 can emit (equality / set membership). */
export const FilterOpSchema = z.enum(['=', 'in']);
export type FilterOp = z.infer<typeof FilterOpSchema>;

/**
 * One scored way a question span matched an ontology element. `via:'name'` is a
 * label/synonym match; `via:'value'` is a database-content match (the span equals
 * one of the column's `sampleValues`), in which case `matchedValue` is set.
 */
export const LinkCandidateSchema = z.object({
  ref: ElementRefSchema,
  kind: z.enum(['class', 'column', 'capability']),
  role: LinkRoleSchema,
  score: z.number().min(0).max(1),
  via: z.enum(['name', 'value']),
  matchedValue: z.string().optional(),
});
export type LinkCandidate = z.infer<typeof LinkCandidateSchema>;

export const MeasureSchema = z.object({
  table: z.string(),
  column: z.string(),
  /** prefLabel of the capability this measure resolved to, when matched via one. */
  capability: z.string().optional(),
});
export const GroupDimSchema = z.object({ table: z.string(), column: z.string() });
export const FilterSchema = z.object({
  table: z.string(),
  column: z.string(),
  op: FilterOpSchema,
  value: z.string(),
  /** True when the literal came from the column's value dictionary (Sprint-1 sampleValues). */
  matchedSample: z.boolean(),
});

/** A SELECT-list column (a non-aggregated attribute the question asks to see). */
export const ProjectionSchema = z.object({ table: z.string(), column: z.string() });
/** One ORDER BY term. */
export const OrderBySchema = z.object({
  table: z.string(),
  column: z.string(),
  dir: z.enum(['asc', 'desc']),
});

/** A span that matched >1 distinct element — recorded with its competing candidates. */
export const AmbiguitySchema = z.object({
  span: z.string(),
  candidates: z.array(LinkCandidateSchema),
});

/**
 * The resolved selection over the ontology — a RESDSQL-style "skeleton" (projection,
 * measures, group-by, filters, order, limit) whose slots are filled with linked
 * columns/values. `tables` is the union of every referenced element's table — the
 * single seam that feeds the join resolver.
 */
export const QueryIntentSchema = z.object({
  question: z.string(),
  tables: z.array(z.string()),
  /** SELECT list of plain attributes (e.g. "reference name" → drivers.driverref). */
  projection: z.array(ProjectionSchema).default([]),
  measures: z.array(MeasureSchema),
  groupDims: z.array(GroupDimSchema),
  filters: z.array(FilterSchema),
  orderBy: z.array(OrderBySchema).default([]),
  limit: z.number().int().positive().nullable().default(null),
  /** Spans with >1 strong candidate; the top-scored is still chosen so the intent is usable. */
  ambiguities: z.array(AmbiguitySchema),
  /** Content tokens that matched nothing — surfaced, never silently dropped. */
  unresolved: z.array(z.string()),
});
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

// ---------------------------------------------------------------------------
// Link hints — the deterministically-parsed payload from a BIRD-style evidence
// string, consumed by the linker (aliases, value illustrations, order/limit).
// ---------------------------------------------------------------------------

/** A phrase the question may use that maps to a specific element ("race number" → races.raceid). */
export const AliasHintSchema = z.object({
  phrase: z.string(),
  ref: ElementRefSchema,
});
/** A value-illustration hint ("status='active'"). */
export const ValueHintSchema = z.object({
  ref: ElementRefSchema,
  value: z.string(),
});
/** An order hint derived from MAX(col)/MIN(col) in the evidence. */
export const OrderHintSchema = z.object({
  column: z.string(),
  dir: z.enum(['asc', 'desc']),
});

export const LinkHintsSchema = z.object({
  aliases: z.array(AliasHintSchema).default([]),
  values: z.array(ValueHintSchema).default([]),
  orderBy: z.array(OrderHintSchema).default([]),
  limit: z.number().int().positive().nullable().default(null),
});
export type LinkHints = z.infer<typeof LinkHintsSchema>;
