import { describe, it, expect } from 'vitest';
import { END } from '@langchain/langgraph';
import { buildGraph, routeAfterValidate } from '../../src/agent/graph.js';
import { OntologyJsonLdSchema } from '../../src/types/ontology.js';
import { fakeConnector, makeGoldenLlm } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

describe('routeAfterValidate', () => {
  const s = (validationErrors: OntologyState['validationErrors'], retryCount: number): OntologyState =>
    ({ validationErrors, retryCount }) as OntologyState;

  it('ends on success (no errors)', () => {
    expect(routeAfterValidate(s([], 0))).toBe(END);
  });
  it('loops back to concept-extract on errors within the retry budget', () => {
    expect(routeAfterValidate(s([{ rule: 'orphan-class', subject: 'x', message: 'm' }], 0))).toBe('concept-extract');
    expect(routeAfterValidate(s([{ rule: 'orphan-class', subject: 'x', message: 'm' }], 1))).toBe('concept-extract');
  });
  it('ends when retries are exhausted', () => {
    expect(routeAfterValidate(s([{ rule: 'orphan-class', subject: 'x', message: 'm' }], 2))).toBe(END);
  });
});

describe('compiled graph (no DB, fake LLM)', () => {
  it('runs all 5 nodes end-to-end and produces a valid ontology', async () => {
    const graph = buildGraph({ llm: makeGoldenLlm(), connect: fakeConnector });
    const final = await graph.invoke({ datasourceId: 'ecommerce', pgConnectionString: 'unused' });

    expect(final.canonicalSchema?.tables).toHaveLength(4);
    expect(final.validationErrors).toEqual([]);
    expect(final.retryCount).toBe(0);

    const ontology = OntologyJsonLdSchema.parse(final.ontology);
    expect(ontology['@graph'].length).toBeGreaterThanOrEqual(15);

    // Acceptance criterion #7: a revenue SKOS entry with >=2 altLabels + a formula referencing both columns.
    const revenue = ontology['@graph'].find(
      (n) => n['@type'] === 'qsl:Capability' && n['skos:prefLabel'] === 'revenue',
    );
    expect(revenue).toBeDefined();
    if (revenue && revenue['@type'] === 'qsl:Capability') {
      expect(revenue['skos:altLabel']?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(revenue['qsl:formulaHint']).toContain('orders.total_amount');
      expect(revenue['qsl:formulaHint']).toContain('refunds.amount');
    }
  });
});
