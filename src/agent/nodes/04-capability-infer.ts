/**
 * Node 4 — Capability Inferrer (LLM + deterministic safety net).
 *
 * The model proposes analytical capabilities (metrics, time grains, fact tables,
 * dimensions) over the whole schema + concepts + relationships. Capabilities that
 * reference a non-existent table are dropped (defensive).
 *
 * Revenue safety net: acceptance requires a "revenue" metric. The few-shot prompt
 * asks for it, but LLM output is nondeterministic — so if no revenue metric came
 * back AND the schema clearly supports it (a gross-amount column + a refund-amount
 * column), we synthesize one, tagged `provenance: 'deterministic-fallback'` for
 * auditability. The validator still gates its formula columns, so the fallback can
 * never reference columns that don't exist.
 */
import { z } from 'zod';
import type { StructuredLlm } from '../../llm/structured-llm.js';
import { CAPABILITY_INFER_SYSTEM, buildCapabilityInferPrompt } from '../../prompts/capability-infer.js';
import type { CanonicalSchema } from '../../types/canonical-schema.js';
import { classIri, type Capability } from '../../types/ontology.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

const NUMERIC_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
]);

/** LLM-facing schema. `.nullable()` (not optional) for robust structured output. */
export const CapabilityItemSchema = z.object({
  kind: z.enum(['metric', 'timeGrain', 'factTable', 'dimension']),
  table: z.string().describe('Table the capability scopes to.'),
  column: z.string().nullable().describe('Column it scopes to, or null.'),
  prefLabel: z.string().nullable().describe('Business name (e.g. "revenue"), or null.'),
  altLabels: z.array(z.string()).describe('Synonyms; empty array if none.'),
  formulaHint: z.string().nullable().describe('SQL-ish formula referencing real table.column names, or null.'),
  unit: z.string().nullable().describe('Unit such as EUR, count, days; or null.'),
});
export const InferredCapabilitiesSchema = z.object({
  capabilities: z.array(CapabilityItemSchema),
});
export type InferredCapabilities = z.infer<typeof InferredCapabilitiesSchema>;

function mapToCapabilities(inferred: InferredCapabilities, schema: CanonicalSchema): Capability[] {
  const tableNames = new Set(schema.tables.map((t) => t.name));
  const out: Capability[] = [];
  for (const item of inferred.capabilities) {
    if (!tableNames.has(item.table)) continue; // drop hallucinated scopes
    out.push({
      kind: item.kind,
      scope: { class: classIri(item.table), ...(item.column ? { property: item.column } : {}) },
      ...(item.prefLabel ? { prefLabel: item.prefLabel } : {}),
      altLabel: item.altLabels,
      ...(item.formulaHint ? { formulaHint: item.formulaHint } : {}),
      ...(item.unit ? { unit: item.unit } : {}),
      provenance: 'llm',
    });
  }
  return out;
}

interface RevenueColumns {
  grossTable: string;
  grossColumn: string;
  refundTable: string;
  refundColumn: string;
}

/** Detect a gross-amount column and a refund-amount column to underpin a revenue metric. */
export function findRevenueColumns(schema: CanonicalSchema): RevenueColumns | null {
  const numericCol = (table: string, predicate: (c: string) => boolean): string | null => {
    const t = schema.tables.find((x) => x.name === table);
    if (!t) return null;
    const col = t.columns.find((c) => NUMERIC_TYPES.has(c.type) && predicate(c.name.toLowerCase()));
    return col?.name ?? null;
  };

  const orderTable = schema.tables.find((t) => /order/i.test(t.name));
  const refundTable = schema.tables.find((t) => /refund/i.test(t.name));
  if (!orderTable || !refundTable) return null;

  const grossColumn =
    numericCol(orderTable.name, (n) => n.includes('total') || n.includes('amount')) ??
    numericCol(orderTable.name, () => true);
  const refundColumn =
    numericCol(refundTable.name, (n) => n.includes('amount') || n.includes('total')) ??
    numericCol(refundTable.name, () => true);
  if (!grossColumn || !refundColumn) return null;

  return { grossTable: orderTable.name, grossColumn, refundTable: refundTable.name, refundColumn };
}

export function applyRevenueFallback(capabilities: Capability[], schema: CanonicalSchema): Capability[] {
  const hasRevenue = capabilities.some(
    (c) => c.kind === 'metric' && (c.prefLabel ?? '').toLowerCase().includes('revenue'),
  );
  if (hasRevenue) return capabilities;

  const rev = findRevenueColumns(schema);
  if (!rev) return capabilities;

  const fallback: Capability = {
    kind: 'metric',
    scope: { class: classIri(rev.grossTable) },
    prefLabel: 'revenue',
    altLabel: ['turnover', 'top-line'],
    formulaHint: `SUM(${rev.grossTable}.${rev.grossColumn}) - COALESCE(SUM(${rev.refundTable}.${rev.refundColumn}), 0)`,
    unit: 'EUR',
    provenance: 'deterministic-fallback',
  };
  return [...capabilities, fallback];
}

export function createCapabilityInferNode(llm: StructuredLlm) {
  return async function capabilityInfer(state: OntologyState): Promise<OntologyStateUpdate> {
    const schema = state.canonicalSchema;
    const concepts = state.conceptCandidates;
    const relationships = state.relationships;
    if (!schema || !concepts || !relationships) {
      throw new Error('capability-infer: required prior state is missing.');
    }

    const user = await buildCapabilityInferPrompt(schema, concepts, relationships);
    const inferred = await llm.generate(InferredCapabilitiesSchema, CAPABILITY_INFER_SYSTEM, user);
    const mapped = mapToCapabilities(inferred, schema);
    const withRevenue = applyRevenueFallback(mapped, schema);
    return { capabilities: withRevenue };
  };
}
