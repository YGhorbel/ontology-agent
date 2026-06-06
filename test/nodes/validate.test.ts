import { describe, it, expect } from 'vitest';
import { validateOntology, createValidateNode } from '../../src/agent/nodes/05-validate.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { deriveRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import {
  classIri,
  type Capability,
  type ConceptCandidate,
  type OntologyJsonLd,
} from '../../src/types/ontology.js';
import { ecommerceSchema } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

/** Minimal valid candidate set: one class + one property per table. */
function baseCandidates(): ConceptCandidate[] {
  const out: ConceptCandidate[] = [];
  for (const t of ecommerceSchema.tables) {
    out.push({
      source: { table: t.name },
      ontologyKind: 'Class',
      prefLabel: t.name,
      altLabel: [],
      rdfsLabel: t.name,
      rdfsComment: `The ${t.name} entity.`,
    });
    const col = t.columns[0]!;
    out.push({
      source: { table: t.name, column: col.name },
      ontologyKind: 'DatatypeProperty',
      prefLabel: `${t.name} ${col.name}`,
      altLabel: [],
      rdfsLabel: col.name,
      rdfsComment: 'A column.',
    });
  }
  return out;
}

const revenueCapability: Capability = {
  kind: 'metric',
  scope: { class: classIri('orders') },
  prefLabel: 'revenue',
  altLabel: ['turnover', 'top-line'],
  formulaHint: 'SUM(orders.total_amount) - COALESCE(SUM(refunds.amount), 0)',
  unit: 'EUR',
  provenance: 'deterministic-fallback',
};

describe('validateOntology', () => {
  it('accepts a well-formed ontology', () => {
    const ontology = assembleOntology(baseCandidates(), deriveRelationships(ecommerceSchema), [revenueCapability]);
    expect(validateOntology(ontology, ecommerceSchema)).toEqual([]);
  });

  it('flags an object property whose domain/range is not a class', () => {
    const ontology: OntologyJsonLd = {
      '@context': { owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', skos: 'http://www.w3.org/2004/02/skos/core#', qsl: 'x' },
      '@graph': [
        {
          '@id': 'qsl:relationship/orders/fk',
          '@type': 'owl:ObjectProperty',
          'rdfs:domain': { '@id': classIri('orders') },
          'rdfs:range': { '@id': classIri('ghost') },
          'rdfs:label': 'customer',
          'qsl:cardinality': 'one-to-many',
          'qsl:provenance': 'declared',
          'qsl:confidence': 1,
        },
      ],
    };
    const errors = validateOntology(ontology, ecommerceSchema);
    expect(errors.some((e) => e.rule === 'object-property-domain-range')).toBe(true);
  });

  it('flags a metric formula referencing an unknown column', () => {
    const bad: Capability = { ...revenueCapability, formulaHint: 'SUM(orders.nonexistent_col)' };
    const ontology = assembleOntology(baseCandidates(), deriveRelationships(ecommerceSchema), [bad]);
    const errors = validateOntology(ontology, ecommerceSchema);
    expect(errors.some((e) => e.rule === 'metric-formula-columns')).toBe(true);
  });

  it('flags duplicate prefLabels within the class scope', () => {
    const cands = baseCandidates();
    cands.push({
      source: { table: 'customers' },
      ontologyKind: 'Class',
      prefLabel: 'orders', // duplicates the orders class prefLabel
      altLabel: [],
      rdfsLabel: 'dup',
      rdfsComment: 'dup',
    });
    const ontology = assembleOntology(cands, [], [revenueCapability]);
    const errors = validateOntology(ontology, ecommerceSchema);
    expect(errors.some((e) => e.rule === 'skos-preflabel-unique')).toBe(true);
  });

  it('flags an orphan class with no properties or relationships', () => {
    const cands: ConceptCandidate[] = [
      { source: { table: 'orphan' }, ontologyKind: 'Class', prefLabel: 'Orphan', altLabel: [], rdfsLabel: 'Orphan', rdfsComment: 'x' },
    ];
    const ontology = assembleOntology(cands, [], []);
    const errors = validateOntology(ontology, ecommerceSchema);
    expect(errors.some((e) => e.rule === 'orphan-class')).toBe(true);
  });
});

describe('createValidateNode', () => {
  it('assembles the ontology and returns it with no errors for valid input', async () => {
    const node = createValidateNode();
    const state = {
      canonicalSchema: ecommerceSchema,
      conceptCandidates: baseCandidates(),
      relationships: deriveRelationships(ecommerceSchema),
      capabilities: [revenueCapability],
    } as OntologyState;
    const update = await node(state);
    expect(update.ontology).toBeTruthy();
    expect(update.validationErrors).toEqual([]);
  });
});
