import { describe, it, expect, vi } from 'vitest';
import {
  singleColumnKeys,
  readDeclaredKeys,
  buildCompositeKeyQuery,
  discoverCompositeKeys,
  discoverKeys,
} from '../../src/profiling/key-discovery.js';
import type { Queryable } from '../../src/storage/pg.js';
import type { CanonicalSchema, Column } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';

/** Build a ColumnProfile; ratios are derived from the supplied counts. */
function prof(
  table: string,
  column: string,
  o: { numRows?: number; distinctCount?: number; nullCount?: number; dataType?: string } = {},
): ColumnProfile {
  const numRows = o.numRows ?? 5;
  const distinctCount = o.distinctCount ?? numRows;
  const nullCount = o.nullCount ?? 0;
  return {
    table,
    column,
    dataType: o.dataType ?? 'integer',
    numRows,
    nullCount,
    nullRatio: numRows > 0 ? nullCount / numRows : 0,
    distinctCount,
    uniquenessRatio: numRows > 0 ? distinctCount / numRows : null,
    min: '1',
    max: '9',
  };
}

const mkCol = (name: string, type = 'integer'): Column => ({
  name,
  type,
  nullable: true,
  default: null,
  comment: null,
  position: 1,
});

describe('singleColumnKeys', () => {
  it('keeps unique columns and classifies certain vs possible', () => {
    const keys = singleColumnKeys([
      prof('orders', 'id', { distinctCount: 5, nullCount: 0 }), // unique, no null → certain
      prof('orders', 'email', { distinctCount: 5, nullCount: 1, dataType: 'character varying' }), // unique, nullable → possible
      prof('orders', 'status', { distinctCount: 2 }), // not unique → excluded
    ]);

    expect(keys.map((k) => k.columns[0])).toEqual(['id', 'email']);
    expect(keys[0]).toMatchObject({ columns: ['id'], unique: true, certain: true, minimal: true, method: 'single-column' });
    expect(keys[1]).toMatchObject({ columns: ['email'], unique: true, certain: false });
  });

  it('excludes columns of an empty table', () => {
    expect(singleColumnKeys([prof('t', 'id', { numRows: 0, distinctCount: 0 })])).toEqual([]);
  });
});

describe('readDeclaredKeys', () => {
  function declaredQueryable(): Queryable {
    return {
      async query(text: string) {
        if (!text.includes('table_constraints')) throw new Error(`unexpected: ${text}`);
        return {
          rows: [
            { table_name: 'customers', constraint_name: 'customers_pkey', constraint_type: 'PRIMARY KEY', column_name: 'id', ordinal_position: 1 },
            { table_name: 'customers', constraint_name: 'customers_email_key', constraint_type: 'UNIQUE', column_name: 'email', ordinal_position: 1 },
            { table_name: 'bridge', constraint_name: 'bridge_pkey', constraint_type: 'PRIMARY KEY', column_name: 'order_id', ordinal_position: 1 },
            { table_name: 'bridge', constraint_name: 'bridge_pkey', constraint_type: 'PRIMARY KEY', column_name: 'product_id', ordinal_position: 2 },
          ],
        };
      },
    };
  }

  it('groups PRIMARY KEY / UNIQUE constraints by table, preserving column order', async () => {
    const map = await readDeclaredKeys(declaredQueryable());

    expect(map.get('customers')).toEqual([
      { columns: ['id'], kind: 'primary' },
      { columns: ['email'], kind: 'unique' },
    ]);
    // composite PK keeps ordinal order
    expect(map.get('bridge')).toEqual([{ columns: ['order_id', 'product_id'], kind: 'primary' }]);
  });
});

describe('buildCompositeKeyQuery', () => {
  it('emits row-constructor distinct counts with index aliases', () => {
    const sql = buildCompositeKeyQuery('t', [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(sql).toContain('count(*) AS n');
    expect(sql).toContain('count(DISTINCT ("a", "b")) AS k0');
    expect(sql).toContain('count(DISTINCT ("c", "d")) AS k1');
    expect(sql).toContain('FROM "t"');
  });
});

describe('discoverCompositeKeys', () => {
  it('Apriori-prunes single-column uniques and finds the minimal 2-col unique', async () => {
    const columns = [mkCol('id'), mkCol('a'), mkCol('b'), mkCol('c')];
    const profiles = [
      prof('t', 'id', { distinctCount: 5 }), // unique → must be pruned out of candidates
      prof('t', 'a', { distinctCount: 3 }),
      prof('t', 'b', { distinctCount: 3 }),
      prof('t', 'c', { distinctCount: 3 }),
    ];
    let lastSql = '';
    const q: Queryable = {
      async query(text: string) {
        lastSql = text;
        // candidates [a,b,c] → pairs (a,b)=k0,(a,c)=k1,(b,c)=k2; make (a,b) unique
        return { rows: [{ n: 5, k0: 5, k1: 4, k2: 4 }] };
      },
    };

    const keys = await discoverCompositeKeys(q, 't', columns, profiles);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ columns: ['a', 'b'], unique: true, certain: true, minimal: true, method: 'composite-probe' });
    expect(lastSql).not.toContain('"id"'); // pruned: never probed
    expect(lastSql).toContain('"a", "b"');
  });

  it('excludes nullable columns from composite candidates', async () => {
    const columns = [mkCol('a'), mkCol('b')];
    const profiles = [
      prof('t', 'a', { distinctCount: 3, nullCount: 0 }),
      prof('t', 'b', { distinctCount: 3, nullCount: 2 }), // nullable → excluded
    ];
    const q: Queryable = { async query() { throw new Error('should not query — no valid pairs'); } };

    expect(await discoverCompositeKeys(q, 't', columns, profiles)).toEqual([]);
  });

  it('caps the number of pairs and warns (no silent truncation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const columns = [mkCol('a'), mkCol('b'), mkCol('c')];
    const profiles = ['a', 'b', 'c'].map((c) => prof('t', c, { distinctCount: 3 }));
    const q: Queryable = { async query() { return { rows: [{ n: 5, k0: 5 }] }; } };

    const keys = await discoverCompositeKeys(q, 't', columns, profiles, { maxPairs: 1 });

    expect(warn).toHaveBeenCalledOnce();
    expect(keys).toHaveLength(1); // only the first pair was tested
    warn.mockRestore();
  });
});

describe('discoverKeys', () => {
  const schema: CanonicalSchema = {
    datasourceId: 't',
    tables: [
      { name: 'orders', comment: null, columns: [mkCol('id'), mkCol('customer_id'), mkCol('code', 'character varying')], sampleRows: [], numericStats: [] },
      { name: 'tags', comment: null, columns: [mkCol('slug', 'character varying')], sampleRows: [], numericStats: [] },
      { name: 'bridge', comment: null, columns: [mkCol('order_id'), mkCol('product_id')], sampleRows: [], numericStats: [] },
    ],
    foreignKeys: [],
  };

  const profiles = [
    prof('orders', 'id', { distinctCount: 5 }), // unique → declared PK
    prof('orders', 'customer_id', { distinctCount: 3 }),
    prof('orders', 'code', { distinctCount: 3, dataType: 'character varying' }),
    prof('tags', 'slug', { distinctCount: 5, dataType: 'character varying' }), // unique, UNDECLARED
    prof('bridge', 'order_id', { distinctCount: 3 }),
    prof('bridge', 'product_id', { distinctCount: 3 }),
  ];

  function db(): Queryable {
    return {
      async query(text: string) {
        if (text.includes('table_constraints')) {
          return {
            rows: [
              { table_name: 'orders', constraint_name: 'orders_pkey', constraint_type: 'PRIMARY KEY', column_name: 'id', ordinal_position: 1 },
              { table_name: 'bridge', constraint_name: 'bridge_pkey', constraint_type: 'PRIMARY KEY', column_name: 'order_id', ordinal_position: 1 },
              { table_name: 'bridge', constraint_name: 'bridge_pkey', constraint_type: 'PRIMARY KEY', column_name: 'product_id', ordinal_position: 2 },
            ],
          };
        }
        if (text.includes('count(DISTINCT')) {
          const t = /FROM "([^"]+)"/.exec(text)?.[1] ?? '';
          const n = t === '' ? 0 : 5;
          const row: Record<string, unknown> = { n };
          for (const m of text.match(/AS (k\d+)/g) ?? []) row[m.slice(3)] = n - 1; // none composite-unique
          return { rows: [row] };
        }
        throw new Error(`unexpected: ${text}`);
      },
    };
  }

  it('tags discovered keys declared-vs-undeclared and recovers a declared composite PK', async () => {
    const keys = await discoverKeys(db(), schema, profiles);

    const id = keys.find((k) => k.table === 'orders' && k.columns.join('+') === 'id');
    expect(id).toMatchObject({ declared: 'primary', method: 'single-column', certain: true });

    const slug = keys.find((k) => k.table === 'tags' && k.columns.join('+') === 'slug');
    expect(slug).toMatchObject({ declared: null, method: 'single-column' }); // the interesting discovery

    const bridgePk = keys.find((k) => k.table === 'bridge');
    expect(bridgePk).toMatchObject({
      columns: ['order_id', 'product_id'],
      method: 'declared',
      unique: true,
      certain: true,
      distinctCount: null,
    });

    expect(keys).toHaveLength(3); // orders.id, tags.slug, bridge composite (declared-only)
  });
});
