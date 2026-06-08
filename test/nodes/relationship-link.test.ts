import { describe, it, expect } from 'vitest';
import {
  deriveRelationships,
  mergeRelationships,
  predicateFromColumn,
  createRelationshipLinkNode,
} from '../../src/agent/nodes/03-relationship-link.js';
import { classIri } from '../../src/types/ontology.js';
import { ecommerceSchema } from '../fixtures.js';
import type { ForeignKeyCandidate } from '../../src/types/foreign-key-candidate.js';
import type { OntologyState } from '../../src/agent/state.js';

/** Build a full ForeignKeyCandidate with sensible defaults. */
function fkc(partial: Partial<ForeignKeyCandidate>): ForeignKeyCandidate {
  return {
    kind: 'foreign-key',
    sourceTable: 'a',
    sourceColumn: 'b_id',
    targetTable: 'b',
    targetColumn: 'id',
    junctionTable: null,
    cardinality: 'one-to-many',
    verified: true,
    containmentRatio: 1,
    score: 0.9,
    declared: false,
    evidence: 'ind',
    signals: { nameSimilarity: 1, surrogate: false, rhsReferences: 1 },
    ...partial,
  };
}

describe('predicateFromColumn', () => {
  it('strips a trailing _id and camelCases', () => {
    expect(predicateFromColumn('customer_id')).toBe('customer');
    expect(predicateFromColumn('order_id')).toBe('order');
    expect(predicateFromColumn('parent_category_id')).toBe('parentCategory');
    expect(predicateFromColumn('owner')).toBe('owner');
  });
});

describe('deriveRelationships', () => {
  it('produces one objectProperty per foreign key with correct domain/range', () => {
    const rels = deriveRelationships(ecommerceSchema);
    expect(rels).toHaveLength(3);

    const ordersToCustomers = rels.find((r) => r.derivedFrom.foreignKey === 'orders_customer_id_fkey');
    expect(ordersToCustomers).toBeDefined();
    expect(ordersToCustomers?.kind).toBe('objectProperty');
    expect(ordersToCustomers?.source.class).toBe(classIri('orders'));
    expect(ordersToCustomers?.target.class).toBe(classIri('customers'));
    expect(ordersToCustomers?.predicate).toBe('customer');
    expect(ordersToCustomers?.cardinality).toBe('one-to-many');
  });

  it('covers all FK-bearing tables', () => {
    const rels = deriveRelationships(ecommerceSchema);
    const tables = rels.map((r) => r.derivedFrom.table).sort();
    expect(tables).toEqual(['line_items', 'orders', 'refunds']);
  });
});

describe('mergeRelationships', () => {
  it('keeps declared FKs as provenance:declared / confidence:1 with join columns', () => {
    const rels = mergeRelationships(ecommerceSchema, []);
    expect(rels).toHaveLength(3);
    for (const r of rels) {
      expect(r.provenance).toBe('declared');
      expect(r.confidence).toBe(1);
      expect(r.junctionTable).toBeNull();
    }
    const ordersToCustomers = rels.find((r) => r.derivedFrom.foreignKey === 'orders_customer_id_fkey');
    expect(ordersToCustomers?.joinColumns).toEqual({ from: 'customer_id', to: 'id' });
  });

  it('refines a declared FK cardinality from the matching candidate', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ sourceTable: 'orders', sourceColumn: 'customer_id', targetTable: 'customers', targetColumn: 'id', declared: true, cardinality: 'one-to-one' }),
    ]);
    const r = rels.find((x) => x.derivedFrom.foreignKey === 'orders_customer_id_fkey');
    expect(r?.cardinality).toBe('one-to-one');
    expect(r?.provenance).toBe('declared');
  });

  it('adds a discovered FK above the score threshold as provenance:discovered', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', score: 0.9 }),
    ]);
    const r = rels.find((x) => x.source.class === classIri('reviews'));
    expect(r).toBeDefined();
    expect(r?.provenance).toBe('discovered');
    expect(r?.confidence).toBeCloseTo(0.9);
    expect(r?.predicate).toBe('order');
    expect(r?.derivedFrom.foreignKey).toBe('disc__order_id__orders');
    expect(r?.joinColumns).toEqual({ from: 'order_id', to: 'id' });
  });

  it('maps an evidence:name candidate to provenance:inferred-name', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', score: 0.65, evidence: 'name' }),
    ]);
    const r = rels.find((x) => x.source.class === classIri('reviews'));
    expect(r).toBeDefined();
    expect(r?.provenance).toBe('inferred-name');
    expect(r?.confidence).toBeCloseTo(0.65);
    expect(r?.joinColumns).toEqual({ from: 'order_id', to: 'id' });
  });

  it('drops a discovered FK below an explicit score threshold', () => {
    const rels = mergeRelationships(
      ecommerceSchema,
      [fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', score: 0.5 })],
      0.8, // explicit floor; the default (0) would keep it
    );
    expect(rels.some((r) => r.source.class === classIri('reviews'))).toBe(false);
  });

  it('keeps a low-score discovered FK at the default threshold (0)', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', score: 0.1 }),
    ]);
    expect(rels.some((r) => r.source.class === classIri('reviews'))).toBe(true);
  });

  it('drops a low-score FK when an explicit floor is set', () => {
    const rels = mergeRelationships(
      ecommerceSchema,
      [fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', score: 0.1 })],
      0.5,
    );
    expect(rels.some((r) => r.source.class === classIri('reviews'))).toBe(false);
  });

  it('does not double-emit a candidate that duplicates a declared FK', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ sourceTable: 'orders', sourceColumn: 'customer_id', targetTable: 'customers', targetColumn: 'id', declared: false, score: 0.95 }),
    ]);
    const matches = rels.filter((r) => r.source.class === classIri('orders') && r.target.class === classIri('customers'));
    expect(matches).toHaveLength(1);
  });

  it('emits an N:M junction as a single direct many-to-many object property', () => {
    const rels = mergeRelationships(ecommerceSchema, [
      fkc({ kind: 'many-to-many', sourceTable: 'orders', sourceColumn: null, targetTable: 'tags', targetColumn: null, junctionTable: 'order_tags', cardinality: 'many-to-many', score: 0.85 }),
    ]);
    const nm = rels.find((r) => r.junctionTable === 'order_tags');
    expect(nm).toMatchObject({
      cardinality: 'many-to-many',
      source: { class: classIri('orders') },
      target: { class: classIri('tags') },
      provenance: 'discovered',
    });
  });
});

describe('createRelationshipLinkNode', () => {
  it('reads canonicalSchema from state and returns relationships', async () => {
    const node = createRelationshipLinkNode();
    const state = { canonicalSchema: ecommerceSchema } as OntologyState;
    const update = await node(state);
    expect(update.relationships).toHaveLength(3);
  });

  it('merges declared FKs with discovered candidates from state', async () => {
    const node = createRelationshipLinkNode();
    const state = {
      canonicalSchema: ecommerceSchema,
      foreignKeyCandidates: [fkc({ sourceTable: 'reviews', sourceColumn: 'order_id', targetTable: 'orders', score: 0.9 })],
    } as OntologyState;
    const update = await node(state);
    expect(update.relationships).toHaveLength(4);
    expect(update.relationships?.some((r) => r.provenance === 'discovered')).toBe(true);
  });

  it('throws when canonicalSchema is missing', async () => {
    const node = createRelationshipLinkNode();
    await expect(node({ canonicalSchema: null } as OntologyState)).rejects.toThrow(/canonicalSchema is missing/);
  });
});
