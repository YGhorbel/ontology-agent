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
import type { ColumnProp, SubgraphPayload } from './graph-model.js';
import { tableOfClassIri } from './graph-build.js';
import { datatypePropertyIri } from '../types/ontology.js';
import { normalize } from './text-normalize.js';

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

/** A property-IRI → ColumnProp map for the payload (mirrors `payloadIris`' class/column walk).
 * Exported so the planner menu can annotate each offered IRI with its column's semantics (ADR-010). */
export function payloadColumnByIri(payload: SubgraphPayload): Map<string, ColumnProp> {
  const m = new Map<string, ColumnProp>();
  for (const c of payload.classes) {
    const table = tableOfClassIri(c.iri);
    for (const p of c.properties) m.set(datatypePropertyIri(table, p.col), p);
  }
  return m;
}

/**
 * Value-grounding (ADR-009). Filter literals are grounded against a column's profiled sample values —
 * the SQL-side of READS's "constrained option pool": the planner must SELECT a real value, not invent
 * one. It only FIRES for an ENUMERABLE column under an equality/membership op; everywhere else it is a
 * no-op (the safe default), so it never rejects legitimate values on free-text / high-cardinality /
 * numeric columns.
 */
const VALUE_GROUNDED_OPS = new Set<FilterOp>(['=', '!=', 'IN']);
/** Max sample values surfaced in a rejection message (the option pool the planner picks from). */
const OPTION_POOL_CAP = 15;

/**
 * Enumerable ⇔ the payload carries this column's FULL domain: it has samples AND `distinctCount`
 * fits within them (`distinctCount <= sampleValues.length`). Self-protecting: if samples were ever
 * truncated (length < distinctCount) this is false → SKIP, so a real-but-unlisted value is never
 * rejected. (The generator only emits samples when distinctCount ≤ the enum cap, so presence of a
 * full list ⇒ the whole domain — see ADR-009 and src/agent/nodes/05-validate.ts.)
 */
export function isEnumerable(cp: ColumnProp): cp is ColumnProp & { sampleValues: string[]; distinctCount: number } {
  return (
    cp.sampleValues !== undefined &&
    cp.sampleValues.length > 0 &&
    cp.distinctCount !== undefined &&
    cp.distinctCount <= cp.sampleValues.length
  );
}

/** The canonical sample for `literal` (exact match wins; else normalized match), or null if none. */
function canonicalSample(literal: string, samples: string[]): string | null {
  if (samples.includes(literal)) return literal;
  const n = normalize(literal);
  return samples.find((s) => normalize(s) === n) ?? null;
}

/** The string literal(s) a filter value contributes to grounding (numbers contribute none). */
function groundableLiterals(value: string | number | string[]): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return []; // numbers (ids/years/ints) are never value-grounded
}

/**
 * Narrow the IR schema to a specific payload: the only legal property IRIs are those
 * of the payload's classes' columns, and the only legal capability IRIs are the
 * payload's capabilities. A reference outside the payload fails `parse` with a precise
 * issue path. This is the deterministic leash the planner LLM will later be held to.
 *
 * It also value-grounds filter literals (ADR-009): on an enumerable column under `=`/`!=`/`IN`,
 * a literal absent from the column's sample domain is rejected with the option pool surfaced in the
 * issue message (reusing the existing repair plumbing). A literal that matches only after
 * normalization is accepted AND rewritten to its canonical sample value by the trailing transform.
 */
export function specializeIrSchema(payload: SubgraphPayload): z.ZodType<MetricQueryIR> {
  const { properties, capabilities } = payloadIris(payload);
  const colByIri = payloadColumnByIri(payload);

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
    ir.filters?.forEach((f, i) => {
      checkProp(f.property, ctx, ['filters', i, 'property']);
      // Value-grounding: only on an enumerable column under an equality/membership op.
      const cp = colByIri.get(f.property);
      if (!cp || !VALUE_GROUNDED_OPS.has(f.op) || !isEnumerable(cp)) return;
      for (const lit of groundableLiterals(f.value)) {
        if (canonicalSample(lit, cp.sampleValues) === null) {
          const pool = cp.sampleValues.slice(0, OPTION_POOL_CAP).join(', ');
          const more = cp.sampleValues.length > OPTION_POOL_CAP ? ` (+${cp.sampleValues.length - OPTION_POOL_CAP} more)` : '';
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `filter value '${lit}' is not a known value of ${cp.col}; choose one of: ${pool}${more}`,
            path: ['filters', i, 'value'],
          });
        }
      }
    });
  }).transform((ir): MetricQueryIR => {
    // Runs only on parse success (no issues) — so every grounded literal is guaranteed to match.
    // Rewrite each grounded filter value to its canonical sample (fixes case/diacritic mismatches).
    if (!ir.filters) return ir;
    const filters = ir.filters.map((f) => {
      const cp = colByIri.get(f.property);
      if (!cp || !VALUE_GROUNDED_OPS.has(f.op) || !isEnumerable(cp)) return f;
      if (typeof f.value === 'string') {
        const canon = canonicalSample(f.value, cp.sampleValues);
        return canon !== null ? { ...f, value: canon } : f;
      }
      if (Array.isArray(f.value)) {
        return { ...f, value: f.value.map((v) => canonicalSample(v, cp.sampleValues) ?? v) };
      }
      return f;
    });
    return { ...ir, filters };
  });
}
