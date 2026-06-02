/**
 * Shared test fixtures: an in-memory canonical schema mirroring the e-commerce
 * database, and a deterministic "golden" fake LLM whose output is keyed off the
 * table name / capability prompt. Used by the LLM-node unit tests and the e2e test
 * so everything runs green with no API key.
 */
import type { CanonicalSchema } from '../src/types/canonical-schema.js';
import { makeFakeLlm, type FakeResponse, type StructuredLlm } from '../src/llm/structured-llm.js';
import type { Queryable, IntrospectionClient, SchemaConnector } from '../src/storage/pg.js';

export const ecommerceSchema: CanonicalSchema = {
  datasourceId: 'ecommerce',
  tables: [
    {
      name: 'customers',
      comment: 'End customers of the store.',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 },
        { name: 'name', type: 'character varying', nullable: false, default: null, comment: null, position: 2 },
        { name: 'email', type: 'character varying', nullable: false, default: null, comment: null, position: 3 },
        { name: 'created_at', type: 'timestamp with time zone', nullable: false, default: 'now()', comment: null, position: 4 },
        { name: 'status', type: 'character varying', nullable: false, default: "'active'", comment: 'Lifecycle state.', position: 5 },
      ],
      sampleRows: [{ id: 1, name: 'Alice', email: 'alice@example.com', status: 'active' }],
      numericStats: [{ column: 'id', min: 1, max: 3, avg: 2 }],
    },
    {
      name: 'orders',
      comment: 'A purchase placed by a customer.',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 },
        { name: 'customer_id', type: 'integer', nullable: false, default: null, comment: null, position: 2 },
        { name: 'placed_at', type: 'timestamp with time zone', nullable: false, default: null, comment: null, position: 3 },
        { name: 'total_amount', type: 'numeric', nullable: false, default: null, comment: 'Order subtotal.', position: 4 },
        { name: 'currency', type: 'character', nullable: false, default: "'EUR'", comment: null, position: 5 },
        { name: 'status', type: 'character varying', nullable: false, default: "'completed'", comment: null, position: 6 },
      ],
      sampleRows: [{ id: 1, customer_id: 1, total_amount: '120.00', currency: 'EUR' }],
      numericStats: [{ column: 'total_amount', min: 80, max: 250, avg: 150 }],
    },
    {
      name: 'line_items',
      comment: null,
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 },
        { name: 'order_id', type: 'integer', nullable: false, default: null, comment: null, position: 2 },
        { name: 'product_name', type: 'character varying', nullable: false, default: null, comment: null, position: 3 },
        { name: 'quantity', type: 'integer', nullable: false, default: null, comment: null, position: 4 },
        { name: 'unit_price', type: 'numeric', nullable: false, default: null, comment: null, position: 5 },
      ],
      sampleRows: [{ id: 1, order_id: 1, product_name: 'Headphones', quantity: 1, unit_price: '120.00' }],
      numericStats: [{ column: 'quantity', min: 1, max: 2, avg: 1.3 }],
    },
    {
      name: 'refunds',
      comment: 'Refunds against specific orders.',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 },
        { name: 'order_id', type: 'integer', nullable: false, default: null, comment: null, position: 2 },
        { name: 'amount', type: 'numeric', nullable: false, default: null, comment: null, position: 3 },
        { name: 'reason', type: 'text', nullable: true, default: null, comment: null, position: 4 },
        { name: 'processed_at', type: 'timestamp with time zone', nullable: false, default: 'now()', comment: null, position: 5 },
      ],
      sampleRows: [{ id: 1, order_id: 2, amount: '80.00', reason: 'Defective product' }],
      numericStats: [{ column: 'amount', min: 80, max: 80, avg: 80 }],
    },
  ],
  foreignKeys: [
    { name: 'orders_customer_id_fkey', sourceTable: 'orders', sourceColumn: 'customer_id', targetTable: 'customers', targetColumn: 'id', onDelete: 'NO ACTION' },
    { name: 'line_items_order_id_fkey', sourceTable: 'line_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', onDelete: 'NO ACTION' },
    { name: 'refunds_order_id_fkey', sourceTable: 'refunds', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', onDelete: 'NO ACTION' },
  ],
};

/** Golden concept-extract output per table (unique prefLabels within each table). */
const CONCEPTS: Record<string, unknown> = {
  customers: {
    classPrefLabel: 'Customer',
    classAltLabels: ['client', 'buyer'],
    classComment: 'A person who buys from the store.',
    properties: [
      { column: 'id', prefLabel: 'Customer ID', altLabels: [], comment: 'Identifier.' },
      { column: 'name', prefLabel: 'Name', altLabels: ['full name'], comment: 'Customer name.' },
      { column: 'email', prefLabel: 'Email', altLabels: ['email address'], comment: 'Contact email.' },
      { column: 'created_at', prefLabel: 'Signup Date', altLabels: ['registration date'], comment: 'When created.' },
      { column: 'status', prefLabel: 'Lifecycle Status', altLabels: ['state'], comment: 'Active or churned.' },
    ],
  },
  orders: {
    classPrefLabel: 'Order',
    classAltLabels: ['purchase', 'sale'],
    classComment: 'A purchase placed by a customer.',
    properties: [
      { column: 'id', prefLabel: 'Order ID', altLabels: [], comment: 'Identifier.' },
      { column: 'customer_id', prefLabel: 'Ordering Customer', altLabels: ['buyer'], comment: 'Who ordered.' },
      { column: 'placed_at', prefLabel: 'Order Date', altLabels: ['purchase date'], comment: 'When placed.' },
      { column: 'total_amount', prefLabel: 'Order Total', altLabels: ['order value', 'amount'], comment: 'Subtotal.' },
      { column: 'currency', prefLabel: 'Currency', altLabels: [], comment: 'ISO currency.' },
      { column: 'status', prefLabel: 'Order Status', altLabels: ['state'], comment: 'Completed or cancelled.' },
    ],
  },
  line_items: {
    classPrefLabel: 'Line Item',
    classAltLabels: ['order line', 'order item'],
    classComment: 'A single product line within an order.',
    properties: [
      { column: 'id', prefLabel: 'Line Item ID', altLabels: [], comment: 'Identifier.' },
      { column: 'order_id', prefLabel: 'Parent Order', altLabels: [], comment: 'Owning order.' },
      { column: 'product_name', prefLabel: 'Product', altLabels: ['item', 'sku'], comment: 'Product name.' },
      { column: 'quantity', prefLabel: 'Quantity', altLabels: ['qty'], comment: 'Units.' },
      { column: 'unit_price', prefLabel: 'Unit Price', altLabels: ['price'], comment: 'Price per unit.' },
    ],
  },
  refunds: {
    classPrefLabel: 'Refund',
    classAltLabels: ['chargeback', 'reimbursement'],
    classComment: 'Money returned for an order.',
    properties: [
      { column: 'id', prefLabel: 'Refund ID', altLabels: [], comment: 'Identifier.' },
      { column: 'order_id', prefLabel: 'Refunded Order', altLabels: [], comment: 'Order refunded.' },
      { column: 'amount', prefLabel: 'Refund Amount', altLabels: ['refunded value'], comment: 'Amount returned.' },
      { column: 'reason', prefLabel: 'Refund Reason', altLabels: [], comment: 'Why refunded.' },
      { column: 'processed_at', prefLabel: 'Refund Date', altLabels: [], comment: 'When processed.' },
    ],
  },
};

/** Golden capability output. Deliberately OMITS revenue so the deterministic fallback fires. */
const CAPABILITIES = {
  capabilities: [
    { kind: 'metric', table: 'orders', column: null, prefLabel: 'order count', altLabels: ['number of orders'], formulaHint: 'COUNT(orders.id)', unit: 'count' },
    { kind: 'metric', table: 'line_items', column: 'quantity', prefLabel: 'units sold', altLabels: ['quantity sold'], formulaHint: 'SUM(line_items.quantity)', unit: 'count' },
    { kind: 'timeGrain', table: 'orders', column: 'placed_at', prefLabel: 'order date', altLabels: [], formulaHint: null, unit: null },
    { kind: 'factTable', table: 'orders', column: null, prefLabel: null, altLabels: [], formulaHint: null, unit: null },
    { kind: 'dimension', table: 'customers', column: null, prefLabel: null, altLabels: [], formulaHint: null, unit: null },
  ],
};

/**
 * An in-memory `Queryable` that answers node 1's introspection queries from
 * `ecommerceSchema` — lets the full compiled graph run with no real database.
 */
export function makeEcommerceQueryable(): Queryable {
  return {
    async query(text: string) {
      if (text.includes('information_schema.tables')) {
        return { rows: ecommerceSchema.tables.map((t) => ({ table_name: t.name, table_comment: t.comment })) };
      }
      if (text.includes('information_schema.columns')) {
        return {
          rows: ecommerceSchema.tables.flatMap((t) =>
            t.columns.map((c) => ({
              table_name: t.name,
              column_name: c.name,
              data_type: c.type,
              is_nullable: c.nullable ? 'YES' : 'NO',
              column_default: c.default,
              ordinal_position: c.position,
              column_comment: c.comment,
            })),
          ),
        };
      }
      if (text.includes('FOREIGN KEY')) {
        return {
          rows: ecommerceSchema.foreignKeys.map((fk) => ({
            constraint_name: fk.name,
            source_table: fk.sourceTable,
            source_column: fk.sourceColumn,
            target_table: fk.targetTable,
            target_column: fk.targetColumn,
            delete_rule: fk.onDelete,
          })),
        };
      }
      const sample = /^SELECT \* FROM "(\w+)" LIMIT 5/.exec(text.trim());
      if (sample) {
        return { rows: ecommerceSchema.tables.find((t) => t.name === sample[1])?.sampleRows ?? [] };
      }
      const stats = /FROM "(\w+)"$/.exec(text.trim());
      if (text.includes('min(') && stats) {
        const table = ecommerceSchema.tables.find((t) => t.name === stats[1]);
        const row: Record<string, unknown> = {};
        for (const s of table?.numericStats ?? []) {
          row[`${s.column}__min`] = s.min;
          row[`${s.column}__max`] = s.max;
          row[`${s.column}__avg`] = s.avg;
        }
        return { rows: [row] };
      }
      throw new Error(`makeEcommerceQueryable: unexpected query: ${text}`);
    },
  };
}

/** A SchemaConnector backed by the in-memory ecommerce queryable (no real DB). */
export const fakeConnector: SchemaConnector = async (): Promise<IntrospectionClient> => ({
  ...makeEcommerceQueryable(),
  close: async () => undefined,
});

export function makeGoldenLlm(): StructuredLlm {
  const responses: FakeResponse[] = [
    ...Object.entries(CONCEPTS).map(([table, value]) => ({
      when: (user: string) => user.includes(`Table: ${table}`),
      respond: () => value,
    })),
    {
      when: (user: string) => user.includes('Propose the analytical capabilities'),
      respond: () => CAPABILITIES,
    },
  ];
  return makeFakeLlm(responses);
}
