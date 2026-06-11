import { describe, it, expect } from 'vitest';
import { validateOntology, createValidateNode } from '../../src/agent/nodes/05-validate.js';
import { routeAfterValidate } from '../../src/agent/graph.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { deriveRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import {
  classIri,
  type Capability,
  type ConceptCandidate,
  type OntologyJsonLd,
  type ValidationError,
} from '../../src/types/ontology.js';
import type { CanonicalSchema } from '../../src/types/canonical-schema.js';
import type { ColumnFact } from '../../src/types/column-fact.js';
import { ecommerceSchema } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

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
    // Give a *different* table the same prefLabel as another class (no @id collision).
    const customers = cands.find((c) => c.ontologyKind === 'Class' && c.source.table === 'customers')!;
    customers.prefLabel = 'orders'; // duplicates the orders class prefLabel
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

  it('Fix 1: flags a comment citing a value absent from the column samples', () => {
    const cands: ConceptCandidate[] = [
      { source: { table: 'customers' }, ontologyKind: 'Class', prefLabel: 'Customer', altLabel: [], rdfsLabel: 'Customer', rdfsComment: 'A customer.' },
      { source: { table: 'customers', column: 'status' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Status', altLabel: [], rdfsLabel: 'Status', rdfsComment: "Lifecycle, e.g. 'Finished' or 'Retired'." },
    ];
    const facts = [fact('customers', 'status', { distinctCount: 2, sampleValues: ['active', 'churned'] })];
    const ontology = assembleOntology(cands, [], [], facts);
    const errors = validateOntology(ontology, ecommerceSchema, facts);
    const e = errors.find((x) => x.rule === 'comment-cites-known-values');
    expect(e).toBeTruthy();
    expect(e?.message).toContain('Finished');
    expect(e?.origin).toBe('concept');
  });

  it('Fix 1: allows a comment that only cites real sample values', () => {
    const cands: ConceptCandidate[] = [
      { source: { table: 'customers' }, ontologyKind: 'Class', prefLabel: 'Customer', altLabel: [], rdfsLabel: 'Customer', rdfsComment: 'A customer.' },
      { source: { table: 'customers', column: 'status' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Status', altLabel: [], rdfsLabel: 'Status', rdfsComment: "Lifecycle, e.g. 'active'." },
    ];
    const facts = [fact('customers', 'status', { distinctCount: 2, sampleValues: ['active', 'churned'] })];
    const ontology = assembleOntology(cands, [], [], facts);
    expect(validateOntology(ontology, ecommerceSchema, facts).some((e) => e.rule === 'comment-cites-known-values')).toBe(false);
  });

  it('Fix 3: rejects a SUM over a cumulative-snapshot column', () => {
    const f1: CanonicalSchema = {
      datasourceId: 'f1',
      tables: [
        {
          name: 'driverstandings',
          comment: null,
          columns: [
            { name: 'driverstandingsid', type: 'bigint', nullable: false, default: null, comment: null, position: 1 },
            { name: 'points', type: 'real', nullable: true, default: null, comment: null, position: 2 },
          ],
          sampleRows: [],
          numericStats: [],
        },
      ],
      foreignKeys: [],
    };
    const facts = [fact('driverstandings', 'points', { dataType: 'real', distinctCount: 50, temporality: 'cumulative-snapshot' })];
    const cap: Capability = { kind: 'metric', scope: { class: classIri('driverstandings') }, prefLabel: 'championship points', altLabel: [], formulaHint: 'SUM(driverstandings.points)', provenance: 'llm' };
    const ontology = assembleOntology([], [], [cap], facts);
    const errors = validateOntology(ontology, f1, facts);
    const e = errors.find((x) => x.rule === 'cumulative-no-sum');
    expect(e).toBeTruthy();
    expect(e?.origin).toBe('capability');
  });
});

describe('routeAfterValidate', () => {
  const errs = (origin: 'concept' | 'capability'): ValidationError[] => [{ rule: 'orphan-class', subject: 'x', message: 'm', origin }];
  it('routes capability-only errors to capability-infer', () => {
    expect(routeAfterValidate({ validationErrors: errs('capability'), retryCount: 0 } as OntologyState)).toBe('capability-infer');
  });
  it('routes concept errors to concept-extract', () => {
    expect(routeAfterValidate({ validationErrors: errs('concept'), retryCount: 0 } as OntologyState)).toBe('concept-extract');
  });
  it('stops after the retry budget is exhausted', () => {
    expect(routeAfterValidate({ validationErrors: errs('capability'), retryCount: 2 } as OntologyState)).toBe('__end__');
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
