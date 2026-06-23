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
  })
  .refine((o) => (o.byAlias === undefined) !== (o.byProperty === undefined), {
    message: 'orderBy must have exactly one of { byAlias, byProperty }',
  });

export const MetricQueryIRSchema = z.object({
  measures: z.array(MeasureSchema).min(1),
  groupBy: z.array(GroupBySchema).optional(),
  filters: z.array(FilterSchema).optional(),
  orderBy: z.array(OrderBySchema).optional(),
  limit: z.number().int().positive().optional(),
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
    ir.measures.forEach((m, i) => {
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
