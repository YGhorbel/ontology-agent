/**
 * End-to-end test on the real e-commerce fixture.
 *
 * Gated on E2E_DATABASE_URL (the docker `ecommerce` DB). Uses REAL PostgreSQL
 * introspection + the deterministic golden LLM, so it is fully reproducible with
 * no API key. If DATABASE_URL (the ontology store) is also set, it persists the
 * fragments and asserts the >=15 count.
 *
 *   pnpm db:up
 *   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ecommerce \
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ontology_dev \
 *   pnpm test:e2e
 */
import { describe, it, expect } from 'vitest';
import { buildGraph } from '../src/agent/graph.js';
import { makePgConnector } from '../src/storage/pg.js';
import { createOntologyStore } from '../src/storage/ontology-store.js';
import { OntologyJsonLdSchema, type OntologyJsonLd } from '../src/types/ontology.js';
import { makeGoldenLlm } from './fixtures.js';

const TARGET = process.env.E2E_DATABASE_URL;
const STORE = process.env.DATABASE_URL;

describe.skipIf(!TARGET)('e2e: ecommerce ontology generation (real Postgres)', () => {
  it('introspects the real DB, assembles a valid ontology with the revenue metric', async () => {
    const graph = buildGraph({ llm: makeGoldenLlm(), connect: makePgConnector });
    const final = await graph.invoke(
      { datasourceId: 'ecommerce', pgConnectionString: TARGET as string },
      { runName: 'e2e-ontology-generate', tags: ['e2e'] },
    );

    expect(final.validationErrors).toEqual([]);
    const ontology: OntologyJsonLd = OntologyJsonLdSchema.parse(final.ontology);
    expect(ontology['@graph'].length).toBeGreaterThanOrEqual(15);

    const revenue = ontology['@graph'].find(
      (n) => n['@type'] === 'qsl:Capability' && n['skos:prefLabel'] === 'revenue',
    );
    expect(revenue).toBeDefined();
    if (revenue && revenue['@type'] === 'qsl:Capability') {
      expect(revenue['skos:altLabel']?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(revenue['qsl:formulaHint']).toContain('orders.total_amount');
      expect(revenue['qsl:formulaHint']).toContain('refunds.amount');
    }

    // Persist + count if the store DB is available.
    if (STORE) {
      const store = createOntologyStore(STORE);
      try {
        await store.applyDdl();
        const count = await store.persistOntology('ecommerce', ontology);
        expect(count).toBeGreaterThanOrEqual(15);
        expect(await store.countFragments('ecommerce')).toBeGreaterThanOrEqual(15);
      } finally {
        await store.close();
      }
    }
  }, 30_000);
});
