import { describe, it, expect } from 'vitest';
import { introspect, createSchemaIngestNode } from '../../src/agent/nodes/01-schema-ingest.js';
import type { Queryable, IntrospectionClient } from '../../src/storage/pg.js';
import type { OntologyState } from '../../src/agent/state.js';

/** Numeric columns per table, used to fabricate the stats-query response. */
const NUMERIC: Record<string, string[]> = {
  customers: ['id'],
  orders: ['id', 'customer_id', 'total_amount'],
};

/** A fake Queryable that answers each introspection query by inspecting the SQL text. */
function makeFakeQueryable(): Queryable {
  return {
    async query(text: string) {
      if (text.includes('information_schema.tables')) {
        return {
          rows: [
            { table_name: 'customers', table_comment: 'Customers of the store.' },
            { table_name: 'orders', table_comment: null },
          ],
        };
      }
      if (text.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'customers', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: "nextval('c')", ordinal_position: 1, column_comment: null },
            { table_name: 'customers', column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null, ordinal_position: 2, column_comment: 'Full name' },
            { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, ordinal_position: 1, column_comment: null },
            { table_name: 'orders', column_name: 'customer_id', data_type: 'integer', is_nullable: 'NO', column_default: null, ordinal_position: 2, column_comment: null },
            { table_name: 'orders', column_name: 'total_amount', data_type: 'numeric', is_nullable: 'NO', column_default: null, ordinal_position: 3, column_comment: 'Subtotal' },
          ],
        };
      }
      if (text.includes('FOREIGN KEY')) {
        return {
          rows: [
            { constraint_name: 'orders_customer_id_fkey', source_table: 'orders', source_column: 'customer_id', target_table: 'customers', target_column: 'id', delete_rule: 'NO ACTION' },
          ],
        };
      }
      const sample = /^SELECT \* FROM "(\w+)" LIMIT 5/.exec(text);
      if (sample) {
        const t = sample[1];
        return { rows: t === 'customers' ? [{ id: 1, name: 'Alice' }] : [{ id: 1, customer_id: 1, total_amount: '120.00' }] };
      }
      const stats = /FROM "(\w+)"$/.exec(text.trim());
      if (text.includes('min(') && stats) {
        const cols = NUMERIC[stats[1] ?? ''] ?? [];
        const row: Record<string, unknown> = {};
        for (const c of cols) {
          row[`${c}__min`] = 1;
          row[`${c}__max`] = 9;
          row[`${c}__avg`] = 5;
        }
        return { rows: [row] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe('introspect', () => {
  it('builds a canonical schema from information_schema rows', async () => {
    const schema = await introspect(makeFakeQueryable(), 'testds');
    expect(schema.datasourceId).toBe('testds');
    expect(schema.tables.map((t) => t.name)).toEqual(['customers', 'orders']);

    const customers = schema.tables.find((t) => t.name === 'customers')!;
    expect(customers.comment).toBe('Customers of the store.');
    expect(customers.columns).toHaveLength(2);
    expect(customers.columns[0]).toMatchObject({ name: 'id', type: 'integer', nullable: false, position: 1 });
    expect(customers.columns[1]).toMatchObject({ name: 'name', comment: 'Full name' });
    expect(customers.sampleRows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(customers.numericStats).toEqual([{ column: 'id', min: 1, max: 9, avg: 5 }]);

    expect(schema.foreignKeys).toHaveLength(1);
    expect(schema.foreignKeys[0]).toMatchObject({ sourceTable: 'orders', targetTable: 'customers', onDelete: 'NO ACTION' });
  });
});

describe('createSchemaIngestNode', () => {
  it('connects, introspects, and closes the client', async () => {
    let closed = false;
    const connect = async (): Promise<IntrospectionClient> => ({
      ...makeFakeQueryable(),
      close: async () => {
        closed = true;
      },
    });
    const node = createSchemaIngestNode(connect);
    const update = await node({ pgConnectionString: 'postgres://x', datasourceId: 'testds' } as OntologyState);
    expect(update.canonicalSchema?.tables).toHaveLength(2);
    expect(closed).toBe(true);
  });
});
