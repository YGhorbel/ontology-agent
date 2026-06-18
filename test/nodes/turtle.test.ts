import { describe, it, expect } from 'vitest';
import { toTurtle, toTrig } from '../../src/serialize/turtle.js';
import { assembleOntology, partitionDataset } from '../../src/agent/assemble.js';
import { buildOntologyHeader } from '../../src/serialize/ontology-header.js';
import { deriveRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { classIri, type Capability, type ConceptCandidate, type OntologyDataset, type Relationship } from '../../src/types/ontology.js';
import type { ColumnFact } from '../../src/types/column-fact.js';
import { ecommerceSchema } from '../fixtures.js';

const fact = (table: string, column: string, o: Partial<ColumnFact> = {}): ColumnFact => ({
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

function sampleOntology() {
  const concepts: ConceptCandidate[] = [
    { source: { table: 'orders' }, ontologyKind: 'Class', prefLabel: 'Order', altLabel: ['purchase'], rdfsLabel: 'Order', rdfsComment: 'A purchase.' },
    { source: { table: 'orders', column: 'total_amount' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Order Total', altLabel: ['amount'], rdfsLabel: 'Order Total', rdfsComment: 'Subtotal.' },
    { source: { table: 'customers' }, ontologyKind: 'Class', prefLabel: 'Customer', altLabel: [], rdfsLabel: 'Customer', rdfsComment: 'A buyer.' },
    { source: { table: 'customers', column: 'id' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Customer ID', altLabel: [], rdfsLabel: 'Customer ID', rdfsComment: 'PK.' },
  ];
  const caps: Capability[] = [
    { kind: 'metric', scope: { class: classIri('orders') }, prefLabel: 'revenue', altLabel: ['turnover', 'top-line'], formulaHint: 'SUM(orders.total_amount) - COALESCE(SUM(refunds.amount), 0)', unit: 'EUR', provenance: 'deterministic-fallback' },
  ];
  const rels = deriveRelationships(ecommerceSchema).filter((r) => r.derivedFrom.foreignKey === 'orders_customer_id_fkey');
  const facts: ColumnFact[] = [
    fact('orders', 'total_amount', { dataType: 'numeric', distinctCount: 12, sampleValues: ['9.99', '19.99'] }),
    fact('customers', 'id', { dataType: 'integer', isPrimaryKey: true, isUnique: true }),
  ];
  return assembleOntology(concepts, rels, caps, facts);
}

describe('toTurtle', () => {
  const ttl = toTurtle(sampleOntology(), 'ecommerce');

  it('declares all standard + custom prefixes', () => {
    for (const p of ['@prefix owl:', '@prefix rdfs:', '@prefix skos:', '@prefix xsd:', '@prefix qsl:']) {
      expect(ttl).toContain(p);
    }
  });

  it('emits an owl:Ontology header', () => {
    expect(ttl).toMatch(/a owl:Ontology\s*;/);
  });

  it('declares classes and properties with the right OWL types', () => {
    expect(ttl).toContain('a owl:Class ;');
    expect(ttl).toContain('a owl:DatatypeProperty ;');
    expect(ttl).toContain('a owl:ObjectProperty ;');
  });

  it('uses full IRI references for domain/range (not string literals)', () => {
    expect(ttl).toContain('rdfs:domain <https://qwery.dev/semantic-layer/v1/class/orders>');
    expect(ttl).toContain('rdfs:range <https://qwery.dev/semantic-layer/v1/class/customers>');
  });

  it('tags natural-language labels with @en and lists altLabels', () => {
    expect(ttl).toContain('skos:prefLabel "Order"@en');
    expect(ttl).toContain('skos:altLabel "turnover"@en, "top-line"@en');
  });

  it('emits capabilities as qsl:Capability individuals with an IRI scopeClass', () => {
    expect(ttl).toContain('a qsl:Capability ;');
    expect(ttl).toContain('qsl:scopeClass <https://qwery.dev/semantic-layer/v1/class/orders>');
    expect(ttl).toContain('qsl:provenance "deterministic-fallback"');
  });

  it('annotates object properties with provenance + confidence', () => {
    expect(ttl).toContain('qsl:provenance "declared"');
    expect(ttl).toMatch(/qsl:confidence 1\s*\./);
    expect(ttl).toContain('qsl:confidence a owl:AnnotationProperty .');
  });

  it('emits the literal join keys on object properties', () => {
    expect(ttl).toContain('qsl:joinFromColumn "customer_id"');
    expect(ttl).toContain('qsl:joinToColumn "id"');
    expect(ttl).toContain('qsl:joinFromColumn a owl:AnnotationProperty .');
  });

  it('emits column query metadata (dataType, key flags, value samples)', () => {
    expect(ttl).toContain('qsl:dataType "numeric"');
    expect(ttl).toContain('qsl:dataType "integer"');
    expect(ttl).toContain('qsl:isPrimaryKey true');
    expect(ttl).toContain('qsl:isUnique true');
    expect(ttl).toContain('qsl:sampleValues "9.99", "19.99"');
    expect(ttl).toContain('qsl:dataType a owl:AnnotationProperty .');
  });
});

describe('toTrig (Fix 5/6)', () => {
  function dataset(): OntologyDataset {
    const concepts: ConceptCandidate[] = [
      { source: { table: 'a' }, ontologyKind: 'Class', prefLabel: 'A', altLabel: [], rdfsLabel: 'A', rdfsComment: 'a' },
      { source: { table: 'b' }, ontologyKind: 'Class', prefLabel: 'B', altLabel: [], rdfsLabel: 'B', rdfsComment: 'b' },
      { source: { table: 'a', column: 'd' }, ontologyKind: 'DatatypeProperty', prefLabel: 'D', altLabel: [], rdfsLabel: 'D', rdfsComment: 'd' },
    ];
    const rels: Relationship[] = [
      { kind: 'objectProperty', source: { class: classIri('a') }, target: { class: classIri('b') }, predicate: 'hi', cardinality: 'one-to-many', provenance: 'declared', confidence: 1, junctionTable: null, joinColumns: { from: 'b_id', to: 'id' }, derivedFrom: { table: 'a', foreignKey: 'hi_fk' } },
      { kind: 'objectProperty', source: { class: classIri('a') }, target: { class: classIri('b') }, predicate: 'lo', cardinality: 'one-to-many', provenance: 'discovered', confidence: 0.05, junctionTable: null, joinColumns: { from: 'x', to: 'y' }, derivedFrom: { table: 'a', foreignKey: 'lo_fk' } },
    ];
    const facts: ColumnFact[] = [fact('a', 'd', { dataType: 'date', isUnique: true, declaredUnique: false })];
    const ontology = assembleOntology(concepts, rels, [], facts);
    const { assertedGraph, candidateGraph } = partitionDataset(ontology, 0.5);
    const header = buildOntologyHeader({ datasourceId: 'demo', dsn: 'postgresql://u:p@h:5432/demo', schemaList: ['public'], generatorVersion: '0.1.0', buildNumber: 1, createdIso: '2026-06-11T00:00:00.000Z' });
    return { '@context': ontology['@context'], 'qsl:ontology': header, '@graph': assertedGraph, 'qsl:candidateGraph': candidateGraph };
  }

  const trig = toTrig(dataset(), 'demo');

  it('puts low-confidence edges in a named candidate graph, not owl:ObjectProperty', () => {
    expect(trig).toContain('qsl:candidates {');
    expect(trig).toContain('a qsl:CandidateRelationship ;');
  });

  it('carries the Fix 6 header (versionInfo, created, fingerprint)', () => {
    expect(trig).toContain('owl:versionInfo "qsl/v2 generator 0.1.0 build 1"');
    expect(trig).toContain('dcterms:created "2026-06-11T00:00:00.000Z"');
    expect(trig).toContain('qsl:sourceFingerprint "');
  });

  it('marks profiling-observed uniqueness as observedUnique', () => {
    expect(trig).toContain('qsl:observedUnique true');
  });
});

describe('toTurtle — structured temporalityEvidence (Part 2b)', () => {
  it('serializes the evidence object as a single JSON string literal', () => {
    const concepts: ConceptCandidate[] = [
      { source: { table: 'driverstandings' }, ontologyKind: 'Class', prefLabel: 'Standing', altLabel: [], rdfsLabel: 'Standing', rdfsComment: 'A standing.' },
      { source: { table: 'driverstandings', column: 'points' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Points', altLabel: [], rdfsLabel: 'Points', rdfsComment: 'Cumulative points to date.' },
    ];
    const facts: ColumnFact[] = [
      fact('driverstandings', 'points', {
        dataType: 'real',
        temporality: 'cumulative-snapshot',
        temporalityEvidence: { partitionColumns: ['driverid', 'year'], orderColumn: 'round', ratio: 1 },
      }),
    ];
    const ttl = toTurtle(assembleOntology(concepts, [], [], facts), 'formula1');
    expect(ttl).toContain('qsl:temporality "cumulative-snapshot"');
    expect(ttl).toContain('qsl:temporalityEvidence "{\\"partitionColumns\\":[\\"driverid\\",\\"year\\"],\\"orderColumn\\":\\"round\\",\\"ratio\\":1}"');
  });
});
