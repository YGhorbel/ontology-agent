import { describe, it, expect } from 'vitest';
import { mergeRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { createValidateNode, pruneCollidingAltLabels } from '../../src/agent/nodes/05-validate.js';
import { classIri, type Capability, type ConceptCandidate, type Relationship } from '../../src/types/ontology.js';
import type { ColumnFact } from '../../src/types/column-fact.js';
import { ecommerceSchema, fakeConnector } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

const fact = (table: string, column: string, o: Partial<ColumnFact> = {}): ColumnFact => ({
  table,
  column,
  dataType: 'integer',
  isNumericText: false,
  isUnique: false,
  isPrimaryKey: false,
  distinctCount: null,
  nullable: false,
  sampleValues: [],
  ...o,
});

// --- Fix 4: derived cardinality -------------------------------------------------
describe('Fix 4 — derived cardinality', () => {
  it('reads a fact→dimension FK as many-to-one (source non-unique, target unique)', () => {
    const facts = [fact('customers', 'id', { isUnique: true, declaredUnique: true }), fact('orders', 'customer_id', { isUnique: false })];
    const rels = mergeRelationships(ecommerceSchema, [], 0, facts);
    const r = rels.find((x) => x.derivedFrom.foreignKey === 'orders_customer_id_fkey');
    expect(r?.cardinality).toBe('many-to-one');
  });

  it('omits qsl:cardinality on a low-confidence edge', () => {
    const lo: Relationship = {
      kind: 'objectProperty', source: { class: classIri('a') }, target: { class: classIri('b') }, predicate: 'p',
      cardinality: 'many-to-one', provenance: 'discovered', confidence: 0.05, junctionTable: null,
      joinColumns: { from: 'x', to: 'y' }, derivedFrom: { table: 'a', foreignKey: 'lo' },
    };
    const hi: Relationship = { ...lo, confidence: 1, provenance: 'declared', derivedFrom: { table: 'a', foreignKey: 'hi' } };
    const graph = assembleOntology([], [lo, hi], [])['@graph'] as Array<Record<string, unknown>>;
    const loNode = graph.find((n) => n['@id'] === 'qsl:relationship/a/lo')!;
    const hiNode = graph.find((n) => n['@id'] === 'qsl:relationship/a/hi')!;
    expect(loNode['qsl:cardinality']).toBeUndefined();
    expect(hiNode['qsl:cardinality']).toBe('many-to-one');
  });
});

// --- Fix 8: near-miss altLabel guard --------------------------------------------
describe('Fix 8 — altLabel collision guard', () => {
  it('strips "Qualifying position" from results.grid when qualifying.position exists', () => {
    const concepts: ConceptCandidate[] = [
      { source: { table: 'qualifying' }, ontologyKind: 'Class', prefLabel: 'Qualifying', altLabel: [], rdfsLabel: 'Qualifying', rdfsComment: 'q' },
      { source: { table: 'qualifying', column: 'position' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Qualifying Position', altLabel: [], rdfsLabel: 'Qualifying Position', rdfsComment: 'grid slot' },
      { source: { table: 'results' }, ontologyKind: 'Class', prefLabel: 'Result', altLabel: [], rdfsLabel: 'Result', rdfsComment: 'r' },
      { source: { table: 'results', column: 'grid' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Grid', altLabel: ['Qualifying position', 'starting slot'], rdfsLabel: 'Grid', rdfsComment: 'start pos' },
    ];
    const ontology = assembleOntology(concepts, [], []);
    const warnings = pruneCollidingAltLabels(ontology);
    const grid = ontology['@graph'].find((n) => n['@type'] === 'owl:DatatypeProperty' && n['qsl:mapsToColumn'] === 'grid') as Record<string, unknown>;
    expect(grid['skos:altLabel']).toEqual(['starting slot']); // collider dropped, innocent kept
    expect(warnings.some((w) => w.includes('Qualifying position'))).toBe(true);
  });

  it('keeps an altLabel that matches only the property\'s own concept', () => {
    const concepts: ConceptCandidate[] = [
      { source: { table: 'drivers' }, ontologyKind: 'Class', prefLabel: 'Driver', altLabel: [], rdfsLabel: 'Driver', rdfsComment: 'd' },
      { source: { table: 'drivers', column: 'surname' }, ontologyKind: 'DatatypeProperty', prefLabel: 'Surname', altLabel: ['surnames'], rdfsLabel: 'Surname', rdfsComment: 'last name' },
    ];
    const ontology = assembleOntology(concepts, [], []);
    pruneCollidingAltLabels(ontology);
    const surname = ontology['@graph'].find((n) => n['@type'] === 'owl:DatatypeProperty') as Record<string, unknown>;
    expect(surname['skos:altLabel']).toEqual(['surnames']);
  });
});

// --- Fix 9: capability provenance tiers -----------------------------------------
describe('Fix 9 — capability provenance tiers', () => {
  const classes: ConceptCandidate[] = ecommerceSchema.tables.map((t) => ({
    source: { table: t.name }, ontologyKind: 'Class', prefLabel: t.name, altLabel: [], rdfsLabel: t.name, rdfsComment: `${t.name} entity`,
  }));
  const props: ConceptCandidate[] = ecommerceSchema.tables.map((t) => ({
    source: { table: t.name, column: t.columns[0]!.name }, ontologyKind: 'DatatypeProperty', prefLabel: `${t.name} ${t.columns[0]!.name}`, altLabel: [], rdfsLabel: t.columns[0]!.name, rdfsComment: 'c',
  }));
  const metric: Capability = { kind: 'metric', scope: { class: classIri('orders') }, prefLabel: 'units', altLabel: [], formulaHint: 'SUM(orders.total_amount)', unit: 'EUR', provenance: 'llm' };

  const state = (): OntologyState => ({
    canonicalSchema: ecommerceSchema,
    conceptCandidates: [...classes, ...props],
    relationships: [],
    capabilities: [metric],
    pgConnectionString: 'postgresql://x',
    columnFacts: [],
  }) as unknown as OntologyState;

  it('upgrades a metric that passes the dry-run to llm-validated with evidence', async () => {
    const node = createValidateNode(fakeConnector);
    const update = await node(state());
    const cap = update.ontology!['@graph'].find((n) => n['@type'] === 'qsl:Capability') as Record<string, unknown>;
    expect(cap['qsl:provenance']).toBe('llm-validated');
    expect(cap['qsl:validationEvidence']).toContain('dry-run');
  });

  it('stays llm when the dry-run is disabled', async () => {
    const prev = process.env.ONTOLOGY_VALIDATE_DRY_RUN;
    process.env.ONTOLOGY_VALIDATE_DRY_RUN = 'false';
    try {
      const node = createValidateNode(fakeConnector);
      const update = await node(state());
      const cap = update.ontology!['@graph'].find((n) => n['@type'] === 'qsl:Capability') as Record<string, unknown>;
      expect(cap['qsl:provenance']).toBe('llm');
      expect(cap['qsl:validationEvidence']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ONTOLOGY_VALIDATE_DRY_RUN;
      else process.env.ONTOLOGY_VALIDATE_DRY_RUN = prev;
    }
  });
});
