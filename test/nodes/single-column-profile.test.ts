import { describe, it, expect } from 'vitest';
import {
  buildProfileQuery,
  profileTable,
  profileSchema,
  PROFILABLE_TYPES,
} from '../../src/profiling/single-column.js';
import type { Queryable } from '../../src/storage/pg.js';
import type { CanonicalSchema, Column } from '../../src/types/canonical-schema.js';
import { ecommerceSchema } from '../fixtures.js';

/** Build a full Column with sensible defaults; tests only care about name + type. */
const col = (name: string, type: string): Column => ({
  name,
  type,
  nullable: true,
  default: null,
  comment: null,
  position: 1,
});

/** Canned aggregate values for one column, as the profile SQL would return them. */
interface Canned {
  nonNull: number;
  distinct?: number | null;
  min?: string | null;
  max?: string | null;
}

/**
 * A fake Queryable that returns one canned aggregate row matching the
 * index-based aliases `buildProfileQuery` emits (`n`, `cI__nn`, `cI__d`, …).
 * It mirrors the column order it is given, so no SQL parsing is needed.
 */
function fakeQueryable(numRows: number, columns: Column[], canned: Record<string, Canned>): Queryable {
  return {
    async query() {
      const row: Record<string, unknown> = { n: numRows };
      columns.forEach((c, i) => {
        const v = canned[c.name] ?? { nonNull: numRows };
        row[`c${i}__nn`] = v.nonNull;
        if (v.distinct !== undefined) row[`c${i}__d`] = v.distinct;
        if (v.min !== undefined) row[`c${i}__min`] = v.min;
        if (v.max !== undefined) row[`c${i}__max`] = v.max;
      });
      return { rows: [row] };
    },
  };
}

describe('buildProfileQuery', () => {
  it('batches count(*), per-column counts, and distinct/min/max for profilable types', () => {
    const columns = [col('id', 'integer'), col('payload', 'json')];
    const sql = buildProfileQuery('events', columns);

    expect(sql).toContain('count(*) AS n');
    expect(sql).toContain('FROM "events"');
    // profilable column → full aggregate set, index-based aliases
    expect(sql).toContain('count("id") AS c0__nn');
    expect(sql).toContain('count(DISTINCT "id") AS c0__d');
    expect(sql).toContain('min("id")::text AS c0__min');
    expect(sql).toContain('max("id")::text AS c0__max');
    // non-profilable column → only the null-safe count, no distinct/min/max
    expect(sql).toContain('count("payload") AS c1__nn');
    expect(sql).not.toContain('c1__d');
    expect(sql).not.toContain('c1__min');
  });

  it('is a single SELECT (one round-trip per table)', () => {
    const sql = buildProfileQuery('t', [col('a', 'integer'), col('b', 'text')]);
    expect(sql.match(/SELECT/gi)).toHaveLength(1);
  });
});

describe('profileTable', () => {
  it('computes the six metrics and derives null/uniqueness ratios', async () => {
    const columns = [col('id', 'integer'), col('customer_id', 'integer')];
    const q = fakeQueryable(1000, columns, {
      id: { nonNull: 1000, distinct: 1000, min: '1', max: '1000' },
      customer_id: { nonNull: 900, distinct: 200, min: '1', max: '200' },
    });

    const [id, customer] = await profileTable(q, 'orders', columns);

    // id: a unique key candidate (uniqueness ≈ 1.0 → valid FK target)
    expect(id).toMatchObject({
      table: 'orders',
      column: 'id',
      dataType: 'integer',
      numRows: 1000,
      nullCount: 0,
      nullRatio: 0,
      distinctCount: 1000,
      uniquenessRatio: 1,
      min: '1',
      max: '1000',
    });

    // customer_id: nullable, low uniqueness → a many-side / FK source candidate
    expect(customer).toMatchObject({
      column: 'customer_id',
      nullCount: 100,
      nullRatio: 0.1,
      distinctCount: 200,
      uniquenessRatio: 0.2,
    });
  });

  it('treats an empty table as numRows=0 with null uniqueness', async () => {
    const columns = [col('id', 'integer')];
    const q = fakeQueryable(0, columns, { id: { nonNull: 0, distinct: 0, min: null, max: null } });

    const [p] = await profileTable(q, 'empty', columns);

    expect(p).toMatchObject({
      numRows: 0,
      nullCount: 0,
      nullRatio: 0,
      distinctCount: 0,
      uniquenessRatio: null, // undefined for an empty table
      min: null,
      max: null,
    });
  });

  it('flags an all-null column (nullRatio = 1)', async () => {
    const columns = [col('note', 'text')];
    const q = fakeQueryable(500, columns, { note: { nonNull: 0, distinct: 0, min: null, max: null } });

    const [p] = await profileTable(q, 't', columns);

    expect(p).toMatchObject({ numRows: 500, nullCount: 500, nullRatio: 1, distinctCount: 0, uniquenessRatio: 0 });
  });

  it('leaves distinct/min/max null for a non-profilable type but still counts nulls', async () => {
    const columns = [col('payload', 'json')];
    // No distinct/min/max keys are returned for json — the query never asks for them.
    const q = fakeQueryable(10, columns, { payload: { nonNull: 8 } });

    const [p] = await profileTable(q, 'events', columns);

    expect(p).toMatchObject({
      column: 'payload',
      dataType: 'json',
      numRows: 10,
      nullCount: 2,
      nullRatio: 0.2,
      distinctCount: null,
      uniquenessRatio: null,
      min: null,
      max: null,
    });
  });

  it('returns nothing for a table with no columns', async () => {
    const q = fakeQueryable(0, [], {});
    expect(await profileTable(q, 't', [])).toEqual([]);
  });
});

describe('profileSchema', () => {
  /** Answers each table's profile query from the canonical schema (no nulls; all profilable). */
  function schemaQueryable(schema: CanonicalSchema): Queryable {
    return {
      async query(text: string) {
        const m = /FROM "([^"]+)"/.exec(text);
        const table = schema.tables.find((t) => t.name === m?.[1]);
        const row: Record<string, unknown> = { n: 3 };
        table?.columns.forEach((c, i) => {
          row[`c${i}__nn`] = 3;
          if (PROFILABLE_TYPES.has(c.type)) {
            row[`c${i}__d`] = 3;
            row[`c${i}__min`] = 'a';
            row[`c${i}__max`] = 'z';
          }
        });
        return { rows: [row] };
      },
    };
  }

  it('produces one profile per column across all tables', async () => {
    const profiles = await profileSchema(schemaQueryable(ecommerceSchema), ecommerceSchema);

    const totalColumns = ecommerceSchema.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(profiles).toHaveLength(totalColumns);

    const ordersId = profiles.find((p) => p.table === 'orders' && p.column === 'id');
    expect(ordersId).toMatchObject({ numRows: 3, distinctCount: 3, uniquenessRatio: 1 });
  });
});
