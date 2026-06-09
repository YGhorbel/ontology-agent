import { describe, it, expect } from 'vitest';
import { toTurtle } from '../../src/serialize/turtle.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { deriveRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { classIri, type Capability, type ConceptCandidate } from '../../src/types/ontology.js';
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
