import { describe, it, expect } from 'vitest';
import {
  buildContainmentQuery,
  verifyInclusion,
  nameSimilarity,
  inferCardinality,
  scoreForeignKey,
  detectManyToMany,
  discoverForeignKeys,
} from '../../src/profiling/foreign-keys.js';
import type { Queryable } from '../../src/storage/pg.js';
import type { CanonicalSchema } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { KeyCandidate } from '../../src/types/key-candidate.js';
import type { CandidatePair } from '../../src/types/candidate-pair.js';
import type { ForeignKeyCandidate } from '../../src/types/foreign-key-candidate.js';

function prof(table: string, column: string, o: { numRows?: number; distinctCount?: number } = {}): ColumnProfile {
  const numRows = o.numRows ?? 100;
  const distinctCount = o.distinctCount ?? numRows;
  return {
    table,
    column,
    dataType: 'integer',
    numRows,
    nullCount: 0,
    nullRatio: 0,
    distinctCount,
    uniquenessRatio: numRows > 0 ? distinctCount / numRows : null,
    min: '1',
    max: String(numRows),
  };
}

const cp = (st: string, sc: string, tt: string, tc: string, self = false): CandidatePair => ({
  sourceTable: st,
  sourceColumn: sc,
  targetTable: tt,
  targetColumn: tc,
  typeFamily: 'numeric',
  sourceDistinct: 5,
  targetDistinct: 10,
  selfReference: self,
});

const singleKey = (table: string, column: string): KeyCandidate => ({
  table,
  columns: [column],
  numRows: 10,
  distinctCount: 10,
  unique: true,
  certain: true,
  minimal: true,
  declared: 'primary',
  method: 'single-column',
});

describe('buildContainmentQuery', () => {
  it('counts distinct source values missing from the target', () => {
    const sql = buildContainmentQuery(cp('orders', 'customer_id', 'customers', 'id'));
    expect(sql).toContain('count(*) FILTER (WHERE t.v IS NULL) AS missing');
    expect(sql).toContain('"customer_id"');
    expect(sql).toContain('FROM "orders"');
    expect(sql).toContain('FROM "customers"');
  });
});

describe('verifyInclusion', () => {
  const fixed = (src: number, missing: number): Queryable => ({
    async query() {
      return { rows: [{ src_distinct: src, missing }] };
    },
  });

  it('holds when no source value is missing', async () => {
    const r = await verifyInclusion(fixed(200, 0), cp('a', 'x', 'b', 'y'));
    expect(r).toMatchObject({ holds: true, containmentRatio: 1 });
  });

  it('fails (and reports the ratio) when some values are missing', async () => {
    const r = await verifyInclusion(fixed(200, 50), cp('a', 'x', 'b', 'y'));
    expect(r.holds).toBe(false);
    expect(r.containmentRatio).toBeCloseTo(0.75);
  });
});

describe('nameSimilarity', () => {
  it('is high when the column base matches the target table', () => {
    expect(nameSimilarity('customer_id', 'customers')).toBe(1);
    expect(nameSimilarity('order_id', 'orders')).toBe(1);
  });
  it('is ~0 for a generic surrogate column vs an unrelated table', () => {
    expect(nameSimilarity('id', 'orders')).toBe(0);
  });
});

describe('inferCardinality', () => {
  it('is one-to-one when the source is also unique, else one-to-many', () => {
    expect(inferCardinality(prof('t', 'x', { distinctCount: 100, numRows: 100 }))).toBe('one-to-one');
    expect(inferCardinality(prof('t', 'x', { distinctCount: 20, numRows: 100 }))).toBe('one-to-many');
  });
});

describe('scoreForeignKey', () => {
  it('scores a name-matching FK high and a surrogate coincidence low', () => {
    expect(scoreForeignKey({ nameSimilarity: 1, surrogate: false, rhsReferences: 1 })).toBeCloseTo(0.9);
    expect(scoreForeignKey({ nameSimilarity: 0, surrogate: true, rhsReferences: 1 })).toBeCloseTo(0.1);
  });
});

describe('detectManyToMany', () => {
  it('promotes a junction (2-col key, both columns FKs into different tables) to N:M', () => {
    const fk = (sc: string, tt: string): ForeignKeyCandidate => ({
      kind: 'foreign-key',
      sourceTable: 'order_products',
      sourceColumn: sc,
      targetTable: tt,
      targetColumn: 'id',
      junctionTable: null,
      cardinality: 'one-to-many',
      verified: true,
      containmentRatio: 1,
      score: 0.8,
      declared: true,
      signals: { nameSimilarity: 0.7, surrogate: false, rhsReferences: 1 },
    });
    const unary = [fk('order_id', 'orders'), fk('product_id', 'products')];
    const keys: KeyCandidate[] = [
      { table: 'order_products', columns: ['order_id', 'product_id'], numRows: 10, distinctCount: 10, unique: true, certain: true, minimal: true, declared: 'primary', method: 'composite-probe' },
    ];

    const nm = detectManyToMany(unary, keys);
    expect(nm).toHaveLength(1);
    expect(nm[0]).toMatchObject({
      kind: 'many-to-many',
      sourceTable: 'orders',
      targetTable: 'products',
      junctionTable: 'order_products',
      cardinality: 'many-to-many',
    });
  });
});

describe('discoverForeignKeys', () => {
  const schema = {
    datasourceId: 't',
    tables: [],
    foreignKeys: [
      { name: 'orders_customer_id_fkey', sourceTable: 'orders', sourceColumn: 'customer_id', targetTable: 'customers', targetColumn: 'id', onDelete: 'NO ACTION' },
    ],
  } as unknown as CanonicalSchema;

  const profiles = [
    prof('orders', 'customer_id', { distinctCount: 20, numRows: 100 }), // non-unique source → 1:N
    prof('customers', 'id', { distinctCount: 100, numRows: 100 }),
  ];
  const keys = [singleKey('customers', 'id'), singleKey('orders', 'id')];
  const pairs = [
    cp('orders', 'customer_id', 'customers', 'id'), // real FK — IND holds
    cp('customers', 'id', 'orders', 'id'), // coincidental — IND fails
  ];

  /** IND holds only for the listed (source.col → targetTable) keys. */
  function fakeDb(holds: Set<string>): Queryable {
    return {
      async query(text: string) {
        const src = /SELECT DISTINCT "([^"]+)" AS v FROM "([^"]+)"/.exec(text);
        const tgt = /LEFT JOIN \(SELECT DISTINCT "[^"]+" AS v FROM "([^"]+)"\)/.exec(text);
        const k = `${src?.[2]}.${src?.[1]}→${tgt?.[1]}`;
        const ok = holds.has(k);
        return { rows: [{ src_distinct: 100, missing: ok ? 0 : 40 }] };
      },
    };
  }

  it('verifies, promotes the real FK with cardinality + declared, and drops the coincidence', async () => {
    const db = fakeDb(new Set(['orders.customer_id→customers']));
    const result = await discoverForeignKeys(db, schema, profiles, keys, pairs);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'foreign-key',
      sourceTable: 'orders',
      sourceColumn: 'customer_id',
      targetTable: 'customers',
      targetColumn: 'id',
      cardinality: 'one-to-many',
      verified: true,
      declared: true,
    });
    expect(result[0]?.score).toBeGreaterThan(0.8); // name-matching, real FK
  });

  it('marks an undeclared verified FK as declared:false', async () => {
    const bareSchema = { datasourceId: 't', tables: [], foreignKeys: [] } as unknown as CanonicalSchema;
    const db = fakeDb(new Set(['orders.customer_id→customers']));
    const result = await discoverForeignKeys(db, bareSchema, profiles, keys, pairs);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ declared: false, verified: true });
  });
});
