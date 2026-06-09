import { describe, it, expect } from 'vitest';
import {
  isNumericText,
  uniqueKeyColumns,
  deriveColumnFacts,
  sampleCategoricalValues,
} from '../../src/profiling/column-facts.js';
import type { Queryable } from '../../src/storage/pg.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { KeyCandidate } from '../../src/types/key-candidate.js';

/** Generic column profile; min/max default to '1'..'10' unless overridden. */
function prof(
  table: string,
  column: string,
  o: { dataType?: string; distinctCount?: number | null; nullCount?: number; min?: string | null; max?: string | null } = {},
): ColumnProfile {
  const numRows = 100;
  const distinctCount = o.distinctCount === undefined ? numRows : o.distinctCount;
  return {
    table,
    column,
    dataType: o.dataType ?? 'integer',
    numRows,
    nullCount: o.nullCount ?? 0,
    nullRatio: (o.nullCount ?? 0) / numRows,
    distinctCount,
    uniquenessRatio: distinctCount !== null ? distinctCount / numRows : null,
    min: o.min === undefined ? '1' : o.min,
    max: o.max === undefined ? '10' : o.max,
  };
}

const singleKey = (table: string, column: string, declared: 'primary' | 'unique' | null): KeyCandidate => ({
  table,
  columns: [column],
  numRows: 100,
  distinctCount: 100,
  unique: true,
  certain: true,
  minimal: true,
  declared,
  method: declared ? 'declared' : 'single-column',
});

describe('isNumericText', () => {
  it('is true for a text column whose values parse as numbers', () => {
    expect(isNumericText(prof('t', 'c', { dataType: 'text', min: '1', max: '99' }))).toBe(true);
    expect(isNumericText(prof('t', 'c', { dataType: 'character varying', min: '0.5', max: '12.3' }))).toBe(true);
  });
  it('is false for genuine text and for native numeric columns', () => {
    expect(isNumericText(prof('t', 'c', { dataType: 'text', min: 'apple', max: 'pear' }))).toBe(false);
    expect(isNumericText(prof('t', 'c', { dataType: 'integer', min: '1', max: '99' }))).toBe(false);
  });
  it('is false when min/max are unknown', () => {
    expect(isNumericText(prof('t', 'c', { dataType: 'text', min: null, max: null }))).toBe(false);
  });
});

describe('uniqueKeyColumns', () => {
  it('collects single-column unique keys only', () => {
    const keys = [singleKey('t', 'id', 'primary'), { ...singleKey('t', 'x', null), columns: ['x', 'y'] }];
    expect(uniqueKeyColumns(keys).has('t id')).toBe(true);
    expect(uniqueKeyColumns(keys).has('t x')).toBe(false); // composite, not single-column
  });
});

describe('deriveColumnFacts', () => {
  it('flags primary key and uniqueness from single-column keys', () => {
    const profiles = [prof('t', 'id'), prof('t', 'email', { dataType: 'text', min: 'a', max: 'z' })];
    const keys = [singleKey('t', 'id', 'primary'), singleKey('t', 'email', 'unique')];
    const facts = deriveColumnFacts(profiles, keys, new Map());
    const id = facts.find((f) => f.column === 'id')!;
    const email = facts.find((f) => f.column === 'email')!;
    expect(id).toMatchObject({ isPrimaryKey: true, isUnique: true, dataType: 'integer' });
    expect(email).toMatchObject({ isPrimaryKey: false, isUnique: true });
  });

  it('attaches sampled values and reports observed nullability', () => {
    const profiles = [prof('t', 'status', { dataType: 'text', distinctCount: 2, nullCount: 3, min: 'a', max: 'b' })];
    const samples = new Map([['t status', ['active', 'closed']]]);
    const facts = deriveColumnFacts(profiles, [], samples);
    expect(facts[0]).toMatchObject({ sampleValues: ['active', 'closed'], nullable: true });
  });
});

describe('sampleCategoricalValues', () => {
  function fakeDb(valuesByCol: Record<string, string[]>, calls: string[]): Queryable {
    return {
      async query(text: string) {
        calls.push(text);
        const col = /SELECT DISTINCT "([^"]+)"::text/.exec(text)?.[1];
        const vals = col ? valuesByCol[col] ?? [] : [];
        return { rows: vals.map((v) => ({ v })) };
      },
    };
  }

  it('samples low-cardinality non-key columns, skipping high-card and key columns', async () => {
    const profiles = [
      prof('t', 'status', { distinctCount: 3, dataType: 'text', min: 'a', max: 'z' }),
      prof('t', 'id', { distinctCount: 100 }), // high-card AND a key
      prof('t', 'descr', { distinctCount: null, dataType: 'text', min: null, max: null }), // unmeasured
    ];
    const calls: string[] = [];
    const db = fakeDb({ status: ['new', 'done', 'void'] }, calls);
    const out = await sampleCategoricalValues(db, profiles, new Set(['t id']), { maxDistinct: 25 });

    expect(out.get('t status')).toEqual(['new', 'done', 'void']);
    expect(out.has('t id')).toBe(false); // key column skipped
    expect(out.has('t descr')).toBe(false); // unmeasured skipped
    expect(calls.every((c) => c.includes('"status"'))).toBe(true); // only status was queried
  });

  it('respects the LIMIT (maxDistinct) in the query', async () => {
    const calls: string[] = [];
    const db = fakeDb({ status: ['a'] }, calls);
    await sampleCategoricalValues(db, [prof('t', 'status', { distinctCount: 5, dataType: 'text', min: 'a', max: 'b' })], new Set(), { maxDistinct: 10 });
    expect(calls[0]).toContain('LIMIT 10');
  });
});
