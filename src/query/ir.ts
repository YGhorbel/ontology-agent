/**
 * Stage 3a/3b boundary — the typed logical plan (IR) the planner emits and the
 * compiler consumes. The IR references ontology IRIs (capabilities, datatype
 * properties) from a SubgraphPayload — never raw `table.column` strings invented
 * freely. "The LLM chooses, the graph constrains, the compiler writes": this file
 * is the *shape* of the choice; `specializeIrSchema` is the *constraint* (the leash
 * that will later bind the planner LLM to a specific payload).
 *
 * No LLM is called here. The schema is plain zod; `specializeIrSchema(payload)`
 * narrows it so only IRIs present in that payload validate.
 */
import { z } from 'zod';
import type { SubgraphPayload } from './graph-model.js';
import { tableOfClassIri } from './graph-build.js';
import { datatypePropertyIri } from '../types/ontology.js';

export const AggFnSchema = z.enum(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
export type AggFn = z.infer<typeof AggFnSchema>;

export const FilterOpSchema = z.enum(['=', '!=', '<', '<=', '>', '>=', 'IN', 'LIKE']);
export type FilterOp = z.infer<typeof FilterOpSchema>;

/** A measure is EXACTLY one of: a named capability (formulaHint) OR an ad-hoc aggregate. */
export const MeasureSchema = z
  .object({
    capability: z.string().optional(),
    aggExpr: z.object({ fn: AggFnSchema, property: z.string() }).optional(),
    alias: z.string().optional(),
  })
  .refine((m) => (m.capability === undefined) !== (m.aggExpr === undefined), {
    message: 'measure must have exactly one of { capability, aggExpr }',
  });
export type Measure = z.infer<typeof MeasureSchema>;

export const GroupBySchema = z.object({ property: z.string() });

/** A projection column: a bare property ref (no alias — projection emits `table.col` verbatim). */
export const SelectItemSchema = z.object({ property: z.string() });

export const FilterSchema = z.object({
  property: z.string(),
  op: FilterOpSchema,
  value: z.union([z.string(), z.number(), z.array(z.string())]),
});

export const OrderBySchema = z
  .object({
    byAlias: z.string().optional(),
    byProperty: z.string().optional(),
    dir: z.enum(['ASC', 'DESC']),
    nulls: z.enum(['FIRST', 'LAST']).optional(),
  })
  .refine((o) => (o.byAlias === undefined) !== (o.byProperty === undefined), {
    message: 'orderBy must have exactly one of { byAlias, byProperty }',
  });

/**
 * One IR, exactly one of three shapes — distinguished by which fields are present (no literal tag):
 * - projection: `select` (no measures, no groupBy). Ranking = projection that also carries `orderBy`.
 * - aggregation: `measures` (>=1), optional `groupBy`. Unchanged behaviour.
 * The refines below enforce the XOR and keep one coherent shape per query. `distinct` is a
 * projection/ranking-only flag (it is a no-op for aggregation, and the third refine rejects it there).
 */
export const MetricQueryIRSchema = z
  .object({
    select: z.array(SelectItemSchema).min(1).optional(),
    distinct: z.boolean().optional(),
    measures: z.array(MeasureSchema).min(1).optional(),
    groupBy: z.array(GroupBySchema).optional(),
    filters: z.array(FilterSchema).optional(),
    orderBy: z.array(OrderBySchema).optional(),
    limit: z.number().int().positive().optional(),
  })
  .refine((q) => (q.select === undefined) !== (q.measures === undefined), {
    message: 'query must have exactly one of { select, measures }',
  })
  .refine((q) => !(q.select !== undefined && q.groupBy !== undefined), {
    message: 'projection/ranking (select) cannot have groupBy — groupBy belongs to the aggregation shape',
  })
  .refine((q) => !(q.distinct !== undefined && q.select === undefined), {
    message: 'distinct is only valid on the projection/ranking (select) shape',
  });
export type MetricQueryIR = z.infer<typeof MetricQueryIRSchema>;

/** The set of legal property / capability IRIs derivable from a payload. */
export function payloadIris(payload: SubgraphPayload): { properties: Set<string>; capabilities: Set<string> } {
  const properties = new Set<string>();
  for (const c of payload.classes) {
    const table = tableOfClassIri(c.iri);
    for (const p of c.properties) properties.add(datatypePropertyIri(table, p.col));
  }
  const capabilities = new Set(payload.capabilities.map((c) => c.iri));
  return { properties, capabilities };
}

/**
 * Narrow the IR schema to a specific payload: the only legal property IRIs are those
 * of the payload's classes' columns, and the only legal capability IRIs are the
 * payload's capabilities. A reference outside the payload fails `parse` with a precise
 * issue path. This is the deterministic leash the planner LLM will later be held to.
 */
export function specializeIrSchema(payload: SubgraphPayload): z.ZodType<MetricQueryIR> {
  const { properties, capabilities } = payloadIris(payload);

  const checkProp = (iri: string, ctx: z.RefinementCtx, path: (string | number)[]): void => {
    if (!properties.has(iri)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `property IRI not in payload: ${iri}`, path });
    }
  };

  return MetricQueryIRSchema.superRefine((ir, ctx) => {
    ir.select?.forEach((s, i) => checkProp(s.property, ctx, ['select', i, 'property']));
    ir.measures?.forEach((m, i) => {
      if (m.capability !== undefined && !capabilities.has(m.capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `capability IRI not in payload: ${m.capability}`,
          path: ['measures', i, 'capability'],
        });
      }
      if (m.aggExpr !== undefined) checkProp(m.aggExpr.property, ctx, ['measures', i, 'aggExpr', 'property']);
    });
    ir.groupBy?.forEach((g, i) => checkProp(g.property, ctx, ['groupBy', i, 'property']));
    ir.filters?.forEach((f, i) => checkProp(f.property, ctx, ['filters', i, 'property']));
    ir.orderBy?.forEach((o, i) => {
      if (o.byProperty !== undefined) checkProp(o.byProperty, ctx, ['orderBy', i, 'byProperty']);
    });
  });
}
