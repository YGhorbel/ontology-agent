/**
 * Integration checks against a real Ergast F1 Postgres. CI-skipped by default — set
 * ONTOLOGY_F1_DSN (e.g. postgresql://dev:dev@localhost:54321/formula1) to run them.
 * These exercise the DB-dependent fixes (profiling sample values, cumulative-measure
 * detection) end to end on real data.
 */
import { describe, it, expect } from 'vitest';
import { makePgConnector } from '../../src/storage/pg.js';
import { introspect } from '../../src/agent/nodes/01-schema-ingest.js';
import { profileSchema } from '../../src/profiling/single-column.js';
import { discoverKeys } from '../../src/profiling/key-discovery.js';
import { generateCandidatePairs } from '../../src/profiling/candidate-pairs.js';
import { discoverForeignKeys } from '../../src/profiling/foreign-keys.js';
import { buildColumnFacts } from '../../src/profiling/column-facts.js';
import { detectCumulativeMeasures } from '../../src/profiling/monotonicity.js';
import { mergeRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { assembleOntology, partitionDataset } from '../../src/agent/assemble.js';
import type { ConceptCandidate } from '../../src/types/ontology.js';

const dsn = process.env.ONTOLOGY_F1_DSN;

describe.skipIf(!dsn)('F1 integration (real DB)', () => {
  it('tags driverstandings.points and constructorstandings.wins as cumulative-snapshot', async () => {
    const client = await makePgConnector(dsn!);
    try {
      const schema = await introspect(client, 'formula1');
      const profiles = await profileSchema(client, schema);
      const keys = await discoverKeys(client, schema, profiles);
      const pairs = generateCandidatePairs(profiles, keys);
      const fks = await discoverForeignKeys(client, schema, profiles, keys, pairs);
      const cumulative = await detectCumulativeMeasures(client, schema, fks, profiles);

      expect(cumulative.has('driverstandings points')).toBe(true);
      expect(cumulative.has('constructorstandings wins')).toBe(true);

      // Fix 1 data: constructorresults.status is a tiny enumeration; its sample dict has 'D'.
      const facts = await buildColumnFacts(client, profiles, keys);
      const status = facts.find((f) => f.table === 'constructorresults' && f.column === 'status');
      expect(status?.sampleValues).toContain('D');

      // Fix 6: races.date is unique in the snapshot but not a declared key → observedUnique.
      const dateFact = facts.find((f) => f.table === 'races' && f.column === 'date');
      expect(dateFact?.isUnique).toBe(true);
      expect(dateFact?.declaredUnique).toBe(false);

      // Fix 5: assembling the full discovered graph dedupes @ids (no throw) and the export
      // tiering splits declared/high-confidence from low-confidence value-overlap noise.
      const relationships = mergeRelationships(schema, fks, 0, facts);
      // Fix 4: a declared fact→dimension FK reads many-to-one (results.driverid → drivers).
      const factToDim = relationships.find((r) => r.derivedFrom.foreignKey === 'results_driverid_fkey');
      expect(factToDim?.cardinality).toBe('many-to-one');
      const concepts: ConceptCandidate[] = schema.tables.map((t) => ({
        source: { table: t.name },
        ontologyKind: 'Class',
        prefLabel: t.name,
        altLabel: [],
        rdfsLabel: t.name,
        rdfsComment: t.name,
      }));
      const ontology = assembleOntology(concepts, relationships, [], facts);
      const ids = ontology['@graph'].map((n) => n['@id']);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate @id survives
      const { assertedGraph, candidateGraph } = partitionDataset(ontology, 0.5);
      expect(assertedGraph.length).toBeGreaterThan(0);
      expect(candidateGraph.every((n) => n['@type'] === 'qsl:CandidateRelationship')).toBe(true);
    } finally {
      await client.close();
    }
  }, 60000);
});
