/**
 * Node 1b — Relationship Discoverer (deterministic, no LLM).
 *
 * Bridges the standalone data-profiling pipeline into the ontology graph. Over
 * its own READ ONLY connection it runs the four profiling steps in order —
 * single-column profiling → key discovery → candidate-pair prefilter → IND
 * verification + FK promotion — and parks the resulting `ForeignKeyCandidate[]`
 * in state for node 3 (relationship-link) to merge with the declared FKs.
 *
 * Placed after schema-ingest and before concept-extract so it executes exactly
 * once, outside the validate→concept-extract retry loop (the DB work is the most
 * expensive part of the run and is fully deterministic).
 *
 * Reuses the profiling modules verbatim — no discovery logic lives here.
 */
import type { SchemaConnector } from '../../storage/pg.js';
import { profileSchema } from '../../profiling/single-column.js';
import { discoverKeys } from '../../profiling/key-discovery.js';
import { generateCandidatePairs } from '../../profiling/candidate-pairs.js';
import { discoverForeignKeys } from '../../profiling/foreign-keys.js';
import { buildColumnFacts } from '../../profiling/column-facts.js';
import { detectCumulativeMeasures, temporalityEvidenceString } from '../../profiling/monotonicity.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

/** Factory: binds the connector so tests can inject a fake Queryable. */
export function createRelationshipDiscoverNode(connect: SchemaConnector) {
  return async function relationshipDiscover(state: OntologyState): Promise<OntologyStateUpdate> {
    const schema = state.canonicalSchema;
    if (!schema) {
      throw new Error('relationship-discover: canonicalSchema is missing (node 1 did not run).');
    }

    const client = await connect(state.pgConnectionString);
    try {
      const profiles = await profileSchema(client, schema);
      const keys = await discoverKeys(client, schema, profiles);
      const pairs = generateCandidatePairs(profiles, keys);
      const foreignKeyCandidates = await discoverForeignKeys(client, schema, profiles, keys, pairs);
      // Per-column query metadata (type, keyness, numeric-as-text, value dictionaries),
      // reusing the same open connection for the bounded value-sampling pass.
      const columnFacts = await buildColumnFacts(client, profiles, keys);

      // Cumulative-measure detection (Fix 3): tag running-total measures so node 4 never
      // SUMs them. Uses the discovered FK graph for partition/order; runs once, here in 1b.
      const cumulative = await detectCumulativeMeasures(client, schema, foreignKeyCandidates, profiles);
      for (const fact of columnFacts) {
        const evidence = cumulative.get(`${fact.table} ${fact.column}`);
        if (evidence) {
          fact.temporality = 'cumulative-snapshot';
          fact.temporalityEvidence = temporalityEvidenceString(evidence);
        }
      }
      return { foreignKeyCandidates, columnFacts };
    } finally {
      await client.close();
    }
  };
}
