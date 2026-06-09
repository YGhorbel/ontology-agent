import { describe, it, expect } from 'vitest';
import { buildOntologyIndex, tableOfClassIri } from '../../src/query/ontology-index.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { classIri, type Capability, type ConceptCandidate, type Relationship } from '../../src/types/ontology.js';

function sampleOntology() {
  const concepts: ConceptCandidate[] = [
    { source: { table: 'results' }, ontologyKind: 'Class', prefLabel: 'Race Result', altLabel: ['result'], rdfsLabel: 'Race Result', rdfsComment: 'A finishing result.' },
    { source: { table: 'results', column: 'points' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Points', altLabel: [], rdfsLabel: 'Points', rdfsComment: 'Points scored.' },
    { source: { table: 'constructors' }, ontologyKind: 'Class', prefLabel: 'Constructor', altLabel: ['team'], rdfsLabel: 'Constructor', rdfsComment: 'A racing team.' },
    { source: { table: 'constructors', column: 'name' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Name', altLabel: [], rdfsLabel: 'Name', rdfsComment: 'Team name.' },
  ];
  const relationships: Relationship[] = [
    {
      kind: 'objectProperty',
      source: { class: classIri('results') },
      target: { class: classIri('constructors') },
      predicate: 'constructorid',
      cardinality: 'one-to-many',
      provenance: 'declared',
      confidence: 1,
      junctionTable: null,
      joinColumns: { from: 'constructorid', to: 'constructorid' },
      derivedFrom: { table: 'results', foreignKey: 'results_constructorid_fkey' },
    },
  ];
  const caps: Capability[] = [
    { kind: 'factTable', scope: { class: classIri('results') }, altLabel: [], provenance: 'llm' },
  ];
  const columnFacts = [
    { table: 'results', column: 'points', dataType: 'integer', isNumericText: false, isUnique: false, isPrimaryKey: false, distinctCount: 26, nullable: false, sampleValues: [] },
    { table: 'constructors', column: 'name', dataType: 'text', isNumericText: false, isUnique: true, isPrimaryKey: false, distinctCount: 3, nullable: false, sampleValues: ['Alpha', 'Beta', 'Gamma'] },
  ];
  return assembleOntology(concepts, relationships, caps, columnFacts);
}

describe('tableOfClassIri', () => {
  it('takes the last path segment', () => {
    expect(tableOfClassIri('qsl:class/orders')).toBe('orders');
    expect(tableOfClassIri('https://qwery.dev/semantic-layer/v1/class/races')).toBe('races');
  });
});

describe('buildOntologyIndex', () => {
  const index = buildOntologyIndex(sampleOntology());

  it('indexes classes and their columns', () => {
    expect(index.classes.size).toBe(2);
    expect(index.classes.get('results')?.prefLabel).toBe('Race Result');
    expect(index.columnsByTable.get('results')?.map((c) => c.column)).toContain('points');
    expect(index.columnsByTable.get('constructors')?.map((c) => c.column)).toContain('name');
  });

  it('extracts join edges with their literal keys from object properties', () => {
    expect(index.joinEdges).toHaveLength(1);
    expect(index.joinEdges[0]).toMatchObject({
      fromTable: 'results',
      fromColumn: 'constructorid',
      toTable: 'constructors',
      toColumn: 'constructorid',
      cardinality: 'one-to-many',
      confidence: 1,
      provenance: 'declared',
    });
  });

  it('indexes capabilities with their scope table', () => {
    const fact = index.capabilities.find((c) => c.kind === 'factTable');
    expect(fact?.scopeTable).toBe('results');
  });

  it('round-trips column query metadata (dataType, uniqueness, sample values)', () => {
    const points = index.columnsByTable.get('results')?.find((c) => c.column === 'points');
    const name = index.columnsByTable.get('constructors')?.find((c) => c.column === 'name');
    expect(points).toMatchObject({ dataType: 'integer' });
    expect(name).toMatchObject({ dataType: 'text', isUnique: true, sampleValues: ['Alpha', 'Beta', 'Gamma'] });
  });
});
