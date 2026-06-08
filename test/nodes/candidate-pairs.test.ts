import { describe, it, expect } from 'vitest';
import {
  typeFamily,
  prefilterPair,
  generateCandidatePairs,
} from '../../src/profiling/candidate-pairs.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { KeyCandidate } from '../../src/types/key-candidate.js';

/** Build a ColumnProfile; min/max default to 1..numRows unless overridden. */
function prof(
  table: string,
  column: string,
  o: {
    numRows?: number;
    distinctCount?: number | null;
    nullCount?: number;
    dataType?: string;
    min?: string | null;
    max?: string | null;
  } = {},
): ColumnProfile {
  const numRows = o.numRows ?? 100;
  const distinctCount = o.distinctCount === undefined ? numRows : o.distinctCount;
  const nullCount = o.nullCount ?? 0;
  return {
    table,
    column,
    dataType: o.dataType ?? 'integer',
    numRows,
    nullCount,
    nullRatio: numRows > 0 ? nullCount / numRows : 0,
    distinctCount,
    uniquenessRatio: distinctCount !== null && numRows > 0 ? distinctCount / numRows : null,
    min: o.min === undefined ? '1' : o.min,
    max: o.max === undefined ? String(numRows) : o.max,
  };
}

const key = (table: string, column: string): KeyCandidate => ({
  table,
  columns: [column],
  numRows: 0,
  distinctCount: null,
  unique: true,
  certain: true,
  minimal: true,
  declared: 'primary',
  method: 'single-column',
});

describe('typeFamily', () => {
  it('groups information_schema types into comparable families', () => {
    expect(typeFamily('integer')).toBe('numeric');
    expect(typeFamily('bigint')).toBe('numeric');
    expect(typeFamily('character varying')).toBe('text');
    expect(typeFamily('timestamp with time zone')).toBe('temporal');
    expect(typeFamily('uuid')).toBe('uuid');
    expect(typeFamily('boolean')).toBe('boolean');
    expect(typeFamily('json')).toBe('other');
  });
});

describe('prefilterPair', () => {
  const target = prof('customers', 'id', { distinctCount: 1000, numRows: 1000, min: '1', max: '1000' });

  it('drops a column paired with itself', () => {
    const v = prefilterPair(target, target);
    expect(v).toMatchObject({ keep: false, reason: 'same-column' });
  });

  it('drops an empty or all-null source', () => {
    const allNull = prof('orders', 'note', { numRows: 100, nullCount: 100 });
    expect(prefilterPair(allNull, target)).toMatchObject({ keep: false, reason: 'source-empty-or-allnull' });
  });

  it('drops type-incompatible pairs', () => {
    const textSrc = prof('orders', 'code', { dataType: 'character varying' });
    expect(prefilterPair(textSrc, target)).toMatchObject({ keep: false, reason: 'type-incompatible' });
  });

  it('drops when distinct(source) > distinct(target)', () => {
    const src = prof('orders', 'x', { distinctCount: 300, min: '1', max: '50' });
    const tgt = prof('t', 'id', { distinctCount: 200, min: '1', max: '1000' });
    expect(prefilterPair(src, tgt)).toMatchObject({ keep: false, reason: 'distinct-exceeds' });
  });

  it('drops when the source range falls outside the target range', () => {
    const src = prof('orders', 'x', { distinctCount: 50, min: '1', max: '300' });
    const tgt = prof('t', 'id', { distinctCount: 200, min: '1', max: '200' });
    expect(prefilterPair(src, tgt)).toMatchObject({ keep: false, reason: 'range-outside' });
  });

  it('compares numeric ranges numerically, not lexicographically', () => {
    // lexicographically "100" < "99"; numerically 100 > 99 → must be range-outside
    const src = prof('orders', 'x', { distinctCount: 10, min: '1', max: '100' });
    const tgt = prof('t', 'id', { distinctCount: 50, min: '1', max: '99' });
    expect(prefilterPair(src, tgt)).toMatchObject({ keep: false, reason: 'range-outside' });
  });

  it('keeps a type-matching, in-range, non-exceeding pair', () => {
    const src = prof('orders', 'customer_id', { distinctCount: 200, numRows: 500, min: '1', max: '200' });
    expect(prefilterPair(src, target)).toEqual({ keep: true });
  });

  it('keeps a strong-name pair despite distinct-exceeds / range-outside', () => {
    // a trimmed target: source references more (and higher) raceids than survive in `races`
    const src = prof('driverstandings', 'raceid', { distinctCount: 300, numRows: 900, min: '1', max: '300' });
    const tgt = prof('races', 'raceid', { distinctCount: 100, numRows: 100, min: '1', max: '100' });
    expect(prefilterPair(src, tgt, false)).toMatchObject({ keep: false }); // pruned without the name signal
    expect(prefilterPair(src, tgt, true)).toEqual({ keep: true }); // kept when name-matched
  });

  it('still drops a type-incompatible pair even when name-matched', () => {
    const textSrc = prof('orders', 'code', { dataType: 'character varying' });
    expect(prefilterPair(textSrc, target, true)).toMatchObject({ keep: false, reason: 'type-incompatible' });
  });
});

describe('generateCandidatePairs', () => {
  const profiles: ColumnProfile[] = [
    prof('customers', 'id', { distinctCount: 1000, numRows: 1000, min: '1', max: '1000' }),
    prof('customers', 'name', { dataType: 'character varying', distinctCount: 1000, min: 'a', max: 'z' }),
    prof('orders', 'id', { distinctCount: 500, numRows: 500, min: '1', max: '500' }),
    prof('orders', 'customer_id', { distinctCount: 200, numRows: 500, min: '1', max: '200' }),
    prof('employees', 'id', { distinctCount: 50, numRows: 50, min: '1', max: '50' }),
    prof('employees', 'manager_id', { distinctCount: 10, numRows: 50, nullCount: 5, min: '1', max: '50' }),
  ];
  const keys = [key('customers', 'id'), key('orders', 'id'), key('employees', 'id')];

  it('restricts targets to single-column keys and prunes impossible pairs', () => {
    const pairs = generateCandidatePairs(profiles, keys);
    const label = (p: { sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string }) =>
      `${p.sourceTable}.${p.sourceColumn}→${p.targetTable}.${p.targetColumn}`;
    const labels = pairs.map(label);

    // the real FK survives
    expect(labels).toContain('orders.customer_id→customers.id');
    // text column never pairs with a numeric key (type-incompatible)
    expect(labels.some((l) => l.startsWith('customers.name→'))).toBe(false);
    // every kept target is a declared key column
    for (const p of pairs) expect(p.targetColumn).toBe('id');
  });

  it('produces a self-reference pair (manager_id → id, same table)', () => {
    const pairs = generateCandidatePairs(profiles, keys);
    const selfRef = pairs.find(
      (p) => p.sourceTable === 'employees' && p.sourceColumn === 'manager_id' && p.targetTable === 'employees',
    );
    expect(selfRef).toMatchObject({ targetColumn: 'id', selfReference: true });
  });

  it('omits self-references when disabled', () => {
    const pairs = generateCandidatePairs(profiles, keys, { includeSelfReferences: false });
    expect(pairs.some((p) => p.selfReference)).toBe(false);
  });

  it('keeps far fewer pairs than the full source × target grid', () => {
    const pairs = generateCandidatePairs(profiles, keys);
    const considered = profiles.length * keys.length; // 6 × 3 = 18
    expect(pairs.length).toBeLessThan(considered);
  });

  it('recovers a strong-name pair the stats would otherwise prune, stamping nameSimilarity', () => {
    // driverstandings.raceid references more/higher raceids than survive in a trimmed `races`
    const trimmed: ColumnProfile[] = [
      prof('races', 'raceid', { distinctCount: 100, numRows: 100, min: '1', max: '100' }),
      prof('driverstandings', 'raceid', { distinctCount: 300, numRows: 900, min: '1', max: '300' }),
    ];
    const pairs = generateCandidatePairs(trimmed, [key('races', 'raceid')]);
    const rec = pairs.find((p) => p.sourceTable === 'driverstandings' && p.targetTable === 'races');
    expect(rec).toBeDefined();
    expect(rec?.nameSimilarity).toBe(1); // raceid → races
  });
});
