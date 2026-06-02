import { describe, it, expect } from 'vitest';
import {
  createCapabilityInferNode,
  findRevenueColumns,
  applyRevenueFallback,
} from '../../src/agent/nodes/04-capability-infer.js';
import { makeFakeLlm } from '../../src/llm/structured-llm.js';
import { classIri, type Capability } from '../../src/types/ontology.js';
import { ecommerceSchema, makeGoldenLlm } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

const baseState = {
  canonicalSchema: ecommerceSchema,
  conceptCandidates: [],
  relationships: [],
} as unknown as OntologyState;

describe('findRevenueColumns', () => {
  it('locates the gross-amount and refund-amount columns', () => {
    const rev = findRevenueColumns(ecommerceSchema);
    expect(rev).toEqual({
      grossTable: 'orders',
      grossColumn: 'total_amount',
      refundTable: 'refunds',
      refundColumn: 'amount',
    });
  });

  it('returns null when there is no refund table', () => {
    const noRefunds = { ...ecommerceSchema, tables: ecommerceSchema.tables.filter((t) => t.name !== 'refunds') };
    expect(findRevenueColumns(noRefunds)).toBeNull();
  });
});

describe('applyRevenueFallback', () => {
  it('synthesizes a tagged revenue metric when the LLM omitted it', () => {
    const out = applyRevenueFallback([], ecommerceSchema);
    const revenue = out.find((c) => c.prefLabel === 'revenue');
    expect(revenue).toBeDefined();
    expect(revenue?.provenance).toBe('deterministic-fallback');
    expect(revenue?.altLabel).toEqual(['turnover', 'top-line']);
    expect(revenue?.formulaHint).toContain('orders.total_amount');
    expect(revenue?.formulaHint).toContain('refunds.amount');
  });

  it('does not duplicate revenue when the LLM already provided it', () => {
    const llmRevenue: Capability = {
      kind: 'metric',
      scope: { class: classIri('orders') },
      prefLabel: 'revenue',
      altLabel: ['turnover'],
      formulaHint: 'SUM(orders.total_amount)',
      unit: 'EUR',
      provenance: 'llm',
    };
    const out = applyRevenueFallback([llmRevenue], ecommerceSchema);
    expect(out.filter((c) => c.prefLabel === 'revenue')).toHaveLength(1);
    expect(out[0]?.provenance).toBe('llm');
  });
});

describe('createCapabilityInferNode', () => {
  it('maps LLM capabilities and appends the revenue fallback', async () => {
    const node = createCapabilityInferNode(makeGoldenLlm());
    const update = await node(baseState);
    const caps = update.capabilities ?? [];
    expect(caps.some((c) => c.kind === 'metric' && c.prefLabel === 'order count')).toBe(true);
    const revenue = caps.find((c) => c.prefLabel === 'revenue');
    expect(revenue?.provenance).toBe('deterministic-fallback');
  });

  it('drops capabilities that reference a non-existent table', async () => {
    const llm = makeFakeLlm([
      {
        when: () => true,
        respond: () => ({
          capabilities: [
            { kind: 'metric', table: 'ghost_table', column: null, prefLabel: 'ghost', altLabels: [], formulaHint: null, unit: null },
          ],
        }),
      },
    ]);
    const node = createCapabilityInferNode(llm);
    const update = await node(baseState);
    const caps = update.capabilities ?? [];
    expect(caps.some((c) => c.prefLabel === 'ghost')).toBe(false);
    // revenue fallback still applies
    expect(caps.some((c) => c.prefLabel === 'revenue')).toBe(true);
  });
});
