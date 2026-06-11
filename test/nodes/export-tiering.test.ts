import { describe, it, expect } from 'vitest';
import { assembleOntology, partitionDataset, dedupeById } from '../../src/agent/assemble.js';
import { buildOntologyIndex, loadFullGraph } from '../../src/query/ontology-index.js';
import { buildOntologyHeader } from '../../src/serialize/ontology-header.js';
import { classIri, type ConceptCandidate, type GraphNode, type Relationship } from '../../src/types/ontology.js';
import type { ColumnFact } from '../../src/types/column-fact.js';

const cls = (table: string): ConceptCandidate => ({
  source: { table },
  ontologyKind: 'Class',
  prefLabel: table,
  altLabel: [],
  rdfsLabel: table,
  rdfsComment: `${table} entity`,
});

const rel = (from: string, to: string, fk: string, provenance: Relationship['provenance'], confidence: number): Relationship => ({
  kind: 'objectProperty',
  source: { class: classIri(from) },
  target: { class: classIri(to) },
  predicate: to,
  cardinality: 'one-to-many',
  provenance,
  confidence,
  junctionTable: null,
  joinColumns: { from: `${to}_id`, to: 'id' },
  derivedFrom: { table: from, foreignKey: fk },
});

describe('partitionDataset (Fix 5)', () => {
  const ontology = assembleOntology(
    [cls('a'), cls('b')],
    [
      rel('a', 'b', 'declared_fk', 'declared', 1),
      rel('a', 'b', 'disc_hi', 'discovered', 0.95),
      rel('a', 'b', 'name_fk', 'inferred-name', 0.65),
      rel('a', 'b', 'disc_lo', 'discovered', 0.05),
    ],
    [],
  );

  it('keeps declared / inferred-name / high-confidence in the asserted graph', () => {
    const { assertedGraph } = partitionDataset(ontology, 0.5);
    const objProps = assertedGraph.filter((n) => n['@type'] === 'owl:ObjectProperty');
    expect(objProps).toHaveLength(3);
  });

  it('demotes low-confidence discovered edges to typed candidates', () => {
    const { candidateGraph } = partitionDataset(ontology, 0.5);
    expect(candidateGraph).toHaveLength(1);
    expect(candidateGraph[0]!['@type']).toBe('qsl:CandidateRelationship');
    expect(candidateGraph[0]!['qsl:confidence']).toBe(0.05);
  });
});

describe('dedupeById (Fix 5)', () => {
  const node = (id: string, label: string): GraphNode => ({
    '@id': id,
    '@type': 'owl:Class',
    'rdfs:label': label,
    'rdfs:comment': 'c',
    'skos:prefLabel': label,
    'qsl:mapsToTable': 'x',
  });

  it('collapses an identical duplicate @id', () => {
    expect(dedupeById([node('qsl:class/x', 'X'), node('qsl:class/x', 'X')])).toHaveLength(1);
  });

  it('throws on a conflicting duplicate @id', () => {
    expect(() => dedupeById([node('qsl:class/x', 'X'), node('qsl:class/x', 'Y')])).toThrow(/conflicting duplicate/);
  });
});

describe('loadFullGraph (Fix 5)', () => {
  it('merges candidateGraph back and strips the header', () => {
    const ontology = assembleOntology([cls('a'), cls('b')], [rel('a', 'b', 'disc_lo', 'discovered', 0.05)], []);
    const { assertedGraph, candidateGraph } = partitionDataset(ontology, 0.5);
    const dataset = {
      '@context': ontology['@context'],
      'qsl:ontology': { '@id': 'x', '@type': 'owl:Ontology', 'owl:versionInfo': 'v', 'dcterms:created': 't', 'qsl:sourceFingerprint': 'f' },
      '@graph': assertedGraph,
      'qsl:candidateGraph': candidateGraph,
    };
    const full = loadFullGraph(dataset);
    // header dropped; asserted classes + the re-typed candidate edge remain
    expect(full['@graph']).toHaveLength(assertedGraph.length + candidateGraph.length);
    // the candidate edge is back as a joinable owl:ObjectProperty
    const index = buildOntologyIndex(full);
    expect(index.joinEdges).toHaveLength(1);
  });
});

describe('buildOntologyHeader (Fix 6)', () => {
  const header = buildOntologyHeader({
    datasourceId: 'formula1',
    dsn: 'postgresql://dev:s3cr3t@localhost:54321/formula1',
    schemaList: ['public'],
    generatorVersion: '0.1.0',
    buildNumber: 42,
    createdIso: '2026-06-11T00:00:00.000Z',
    env: { ONTOLOGY_EXPORT_MIN_CONF: '0.5' } as NodeJS.ProcessEnv,
  });

  it('records a versioned, timestamped, fingerprinted header', () => {
    expect(header['owl:versionInfo']).toContain('qsl/v2');
    expect(header['owl:versionInfo']).toContain('build 42');
    expect(header['dcterms:created']).toBe('2026-06-11T00:00:00.000Z');
    expect(header['qsl:sourceFingerprint']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never leaks credentials into the fingerprint or knobs', () => {
    expect(JSON.stringify(header)).not.toContain('s3cr3t');
    expect(header['qsl:knobs']).toContain('ONTOLOGY_EXPORT_MIN_CONF=0.5');
  });
});

describe('uniqueness provenance (Fix 6)', () => {
  const fact = (table: string, column: string, o: Partial<ColumnFact>): ColumnFact => ({
    table,
    column,
    dataType: 'text',
    isNumericText: false,
    isUnique: false,
    isPrimaryKey: false,
    distinctCount: null,
    nullable: false,
    sampleValues: [],
    ...o,
  });

  it('emits isUnique for declared keys and observedUnique for profiled-only uniqueness', () => {
    const concepts: ConceptCandidate[] = [
      cls('races'),
      { source: { table: 'races', column: 'raceid' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Race ID', altLabel: [], rdfsLabel: 'Race ID', rdfsComment: 'pk' },
      { source: { table: 'races', column: 'date' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Race Date', altLabel: [], rdfsLabel: 'Race Date', rdfsComment: 'when' },
    ];
    const facts = [
      fact('races', 'raceid', { isPrimaryKey: true, isUnique: true, declaredUnique: true }),
      fact('races', 'date', { isUnique: true, declaredUnique: false }),
    ];
    const graph = assembleOntology(concepts, [], [], facts)['@graph'];
    const raceid = graph.find((n) => n['@type'] === 'owl:DatatypeProperty' && n['qsl:mapsToColumn'] === 'raceid') as Record<string, unknown>;
    const date = graph.find((n) => n['@type'] === 'owl:DatatypeProperty' && n['qsl:mapsToColumn'] === 'date') as Record<string, unknown>;
    expect(raceid['qsl:isUnique']).toBe(true);
    expect(raceid['qsl:observedUnique']).toBeUndefined();
    expect(date['qsl:observedUnique']).toBe(true);
    expect(date['qsl:isUnique']).toBeUndefined();
  });
});
