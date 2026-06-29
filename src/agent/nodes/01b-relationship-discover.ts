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
import { detectCumulativeMeasures } from '../../profiling/monotonicity.js';
import { detectSnapshotMeasures } from '../../profiling/snapshot.js';
import { discoverCompositeForeignKeys } from '../../profiling/composite-fk.js';
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
      // As-of-event snapshot detection (ADR-015): generalize the tag to NON-monotonic carried-forward
      // state columns (e.g. a championship `position`) the monotonicity probe misses, so the planner
      // menu (ADR-013) is no longer grain-blind for the snapshot family. Runs after the cumulative
      // probe and reads its map so already-cumulative columns keep their stronger tag and are skipped.
      const snapshot = await detectSnapshotMeasures(client, schema, foreignKeyCandidates, profiles, cumulative);
      for (const fact of columnFacts) {
        const key = `${fact.table} ${fact.column}`;
        // A monotonic cumulative measure keeps its stronger tag; never downgrade it to a plain snapshot.
        const cumulativeEv = cumulative.get(key);
        const snapshotEv = cumulativeEv ? undefined : snapshot.get(key);
        if (cumulativeEv) {
          fact.temporality = 'cumulative-snapshot';
          fact.temporalityEvidence = cumulativeEv;
        } else if (snapshotEv) {
          fact.temporality = 'as-of-event-snapshot';
          fact.temporalityEvidence = snapshotEv;
        }
      }
      // Bounded composite (2-column) FK discovery (Fix 7): direct multi-key joins between
      // fact tables that share ≥2 unary FK parents (e.g. laptimes→results on raceid+driverid).
      const compositeForeignKeys = await discoverCompositeForeignKeys(client, schema, foreignKeyCandidates, keys, profiles);
      return { foreignKeyCandidates, columnFacts, compositeForeignKeys };
    } finally {
      await client.close();
    }
  };
}
