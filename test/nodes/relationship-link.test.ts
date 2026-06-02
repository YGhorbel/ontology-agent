import { describe, it, expect } from 'vitest';
import {
  deriveRelationships,
  predicateFromColumn,
  createRelationshipLinkNode,
} from '../../src/agent/nodes/03-relationship-link.js';
import { classIri } from '../../src/types/ontology.js';
import { ecommerceSchema } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';

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

describe('createRelationshipLinkNode', () => {
  it('reads canonicalSchema from state and returns relationships', async () => {
    const node = createRelationshipLinkNode();
    const state = { canonicalSchema: ecommerceSchema } as OntologyState;
    const update = await node(state);
    expect(update.relationships).toHaveLength(3);
  });

  it('throws when canonicalSchema is missing', async () => {
    const node = createRelationshipLinkNode();
    await expect(node({ canonicalSchema: null } as OntologyState)).rejects.toThrow(/canonicalSchema is missing/);
  });
});
