/**
 * As-of-event snapshot detection (ADR-015) — both gates, both directions.
 *
 * Mirrors the mock-Queryable style of monotonicity.test.ts. The cumulative map is supplied directly
 * (it is the output of detectCumulativeMeasures, tested separately), so these tests isolate the two
 * snapshot gates:
 *   - functional determination: the table's grain must be exactly (entity, event) — one row per
 *     (entity, event). A multi-row-per-event telemetry table, or a non-unique grain, is excluded.
 *   - carry-forward: the von Neumann ratio var(Δ)/var(v) must be low (a carried-forward trajectory),
 *     and the column must actually move (excludes a near-constant attribute).
 * Both gates are grounded in the live F1 numbers: standings.position var(Δ)/var(v) ≈ 0.05 (tagged);
 * results.position ≈ 0.80 and qualifying.position ≈ 0.51 (per-event, untagged); results additionally
 * fails functional determination (historic shared drives ⇒ non-unique (driver, race)).
 */
import { describe, it, expect } from 'vitest';
import { detectSnapshotMeasures, buildVonNeumannQuery, buildGrainUniquenessQuery } from '../../src/profiling/snapshot.js';
import { deriveSequencePlan, type TemporalityEvidence } from '../../src/profiling/monotonicity.js';
import type { CanonicalSchema, Table } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { Queryable } from '../../src/storage/pg.js';

const col = (name: string, type: string): Table['columns'][number] => ({ name, type, nullable: true, default: null, comment: null, position: 1 });

const schema: CanonicalSchema = {
  datasourceId: 'f1',
  tables: [
    { name: 'drivers', comment: null, columns: [col('driverid', 'bigint'), col('surname', 'text')], sampleRows: [], numericStats: [] },
    { name: 'races', comment: null, columns: [col('raceid', 'bigint'), col('year', 'bigint'), col('round', 'bigint'), col('date', 'date')], sampleRows: [], numericStats: [] },
    {
      name: 'driverstandings',
      comment: null,
      columns: [col('driverstandingsid', 'bigint'), col('raceid', 'bigint'), col('driverid', 'bigint'), col('points', 'real'), col('wins', 'bigint'), col('position', 'bigint')],
      sampleRows: [], numericStats: [],
    },
    {
      // Per-event sibling: SAME column names, but no cumulative tag AND historic shared drives make
      // (driver, race) non-unique → fails functional determination.
      name: 'results',
      comment: null,
      columns: [col('resultid', 'bigint'), col('raceid', 'bigint'), col('driverid', 'bigint'), col('points', 'real'), col('position', 'bigint')],
      sampleRows: [], numericStats: [],
    },
  ],
  foreignKeys: [
    { name: 'ds_driverid_fkey', sourceTable: 'driverstandings', sourceColumn: 'driverid', targetTable: 'drivers', targetColumn: 'driverid', onDelete: 'NO ACTION' },
    { name: 'res_driverid_fkey', sourceTable: 'results', sourceColumn: 'driverid', targetTable: 'drivers', targetColumn: 'driverid', onDelete: 'NO ACTION' },
  ],
};

const profile = (table: string, column: string, uniquenessRatio: number | null): ColumnProfile => ({
  table, column, dataType: 'real', numRows: 100, nullCount: 0, nullRatio: 0, distinctCount: 50, uniquenessRatio, min: '0', max: '100',
});

const allProfiles = [
  profile('driverstandings', 'points', 0.4), profile('driverstandings', 'wins', 0.1), profile('driverstandings', 'position', 0.2),
  profile('results', 'points', 0.4), profile('results', 'position', 0.2),
];

const cumulativeStandings = (): Map<string, TemporalityEvidence> =>
  new Map([
    ['driverstandings points', { partitionColumns: ['driverid', 'year'], orderColumn: 'round', signal: 'monotonic', ratio: 1 }],
    ['driverstandings wins', { partitionColumns: ['driverid', 'year'], orderColumn: 'round', signal: 'monotonic', ratio: 1 }],
  ]);

const isGrainQuery = (t: string): boolean => t.includes('count(DISTINCT');
const isVnQuery = (t: string): boolean => t.includes('var_samp(d)');

describe('snapshot SQL builders', () => {
  it('grain-uniqueness query compares row count to distinct (entity…, event) keys', () => {
    const plan = deriveSequencePlan(schema.tables[2]!, schema, [])!;
    const sql = buildGrainUniquenessQuery('driverstandings', plan);
    expect(sql).toContain('count(*) AS total');
    expect(sql).toContain('count(DISTINCT (t."driverid", t."raceid"))');
  });
  it('von Neumann query measures var(Δ)/var(v) and the moved count, partitioned by entity+season', () => {
    const plan = deriveSequencePlan(schema.tables[2]!, schema, [])!;
    const sql = buildVonNeumannQuery('driverstandings', 'position', plan);
    expect(sql).toContain('var_samp(d) AS var_d');
    expect(sql).toContain('var_samp(v) AS var_v');
    expect(sql).toContain("count(*) FILTER (WHERE d <> 0) AS moved");
    expect(sql).toContain('PARTITION BY t."driverid", r."year"');
    expect(sql).toContain('ORDER BY r."round"');
  });
});

describe('detectSnapshotMeasures — both gates', () => {
  it('tags driverstandings.position (grain-unique + carried-forward) and never re-tags the cumulative columns', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (isGrainQuery(text) && text.includes('"driverstandings"')) return { rows: [{ total: 100, keys: 100 }] }; // unique
        if (isGrainQuery(text) && text.includes('"results"')) return { rows: [{ total: 100, keys: 80 }] }; // NON-unique
        if (isVnQuery(text) && text.includes('"position"')) return { rows: [{ var_d: 5, var_v: 100, tot: 90, moved: 54 }] }; // ratio 0.05
        return { rows: [{ var_d: 80, var_v: 100, tot: 90, moved: 54 }] };
      },
    };
    const out = await detectSnapshotMeasures(q, schema, [], allProfiles, cumulativeStandings());
    expect(out.get('driverstandings position')?.signal).toBe('carry-forward');
    expect(out.get('driverstandings position')?.vnRatio).toBeCloseTo(0.05, 5);
    expect(out.has('driverstandings points')).toBe(false);
    expect(out.has('driverstandings wins')).toBe(false);
  });

  it('leaves results.position UNtagged — fails functional determination (non-unique grain)', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (isGrainQuery(text) && text.includes('"driverstandings"')) return { rows: [{ total: 100, keys: 100 }] };
        if (isGrainQuery(text) && text.includes('"results"')) return { rows: [{ total: 100, keys: 80 }] }; // non-unique → skip whole table
        // even if results were probed, its position is volatile:
        return { rows: [{ var_d: 80, var_v: 100, tot: 90, moved: 54 }] };
      },
    };
    const out = await detectSnapshotMeasures(q, schema, [], allProfiles, cumulativeStandings());
    expect(out.has('results position')).toBe(false);
    expect(out.has('results points')).toBe(false);
  });

  it('leaves a per-event column on a grain-unique table UNtagged when it is volatile (high von Neumann ratio)', async () => {
    // driverstandings is grain-unique, but make position look volatile → must NOT be tagged.
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (isGrainQuery(text)) return { rows: [{ total: 100, keys: 100 }] };
        return { rows: [{ var_d: 80, var_v: 100, tot: 90, moved: 54 }] }; // ratio 0.8 > 0.1
      },
    };
    const out = await detectSnapshotMeasures(q, schema, [], allProfiles, cumulativeStandings());
    expect(out.has('driverstandings position')).toBe(false);
  });

  it('leaves a near-CONSTANT column UNtagged even though its von Neumann ratio is low (move floor)', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (isGrainQuery(text)) return { rows: [{ total: 100, keys: 100 }] };
        return { rows: [{ var_d: 1, var_v: 100, tot: 90, moved: 2 }] }; // ratio 0.01 but moves only 2/90 ≈ 0.02
      },
    };
    const out = await detectSnapshotMeasures(q, schema, [], allProfiles, cumulativeStandings());
    expect(out.has('driverstandings position')).toBe(false);
  });
});

describe('detectSnapshotMeasures — cross-domain generality (no f1 hardcoding)', () => {
  // A synthetic finance schema with NO cumulative column anywhere: accounts.balance is an as-of-date
  // snapshot (one row per (customer, period), carried forward); transactions.amount is per-event and
  // its table has many rows per (customer, period) → fails functional determination.
  const fin: CanonicalSchema = {
    datasourceId: 'bank',
    tables: [
      { name: 'customers', comment: null, columns: [col('customerid', 'bigint'), col('name', 'text')], sampleRows: [], numericStats: [] },
      { name: 'statementperiods', comment: null, columns: [col('periodid', 'bigint'), col('year', 'bigint'), col('sequence', 'bigint')], sampleRows: [], numericStats: [] },
      { name: 'accounts', comment: null, columns: [col('accountid', 'bigint'), col('periodid', 'bigint'), col('customerid', 'bigint'), col('balance', 'numeric')], sampleRows: [], numericStats: [] },
      { name: 'transactions', comment: null, columns: [col('txnid', 'bigint'), col('periodid', 'bigint'), col('customerid', 'bigint'), col('amount', 'numeric')], sampleRows: [], numericStats: [] },
    ],
    foreignKeys: [
      { name: 'acc_cust_fk', sourceTable: 'accounts', sourceColumn: 'customerid', targetTable: 'customers', targetColumn: 'customerid', onDelete: 'NO ACTION' },
      { name: 'txn_cust_fk', sourceTable: 'transactions', sourceColumn: 'customerid', targetTable: 'customers', targetColumn: 'customerid', onDelete: 'NO ACTION' },
    ],
  };
  const finProfiles = [profile('accounts', 'balance', 0.6), profile('transactions', 'amount', 0.6)];

  it('tags accounts.balance (carry-forward) but NOT transactions.amount (multi-row-per-period)', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (isGrainQuery(text) && text.includes('"accounts"')) return { rows: [{ total: 100, keys: 100 }] }; // unique
        if (isGrainQuery(text) && text.includes('"transactions"')) return { rows: [{ total: 500, keys: 100 }] }; // many per period
        if (isVnQuery(text) && text.includes('"balance"')) return { rows: [{ var_d: 3, var_v: 1000, tot: 200, moved: 150 }] }; // ratio 0.003
        return { rows: [{ var_d: 1800, var_v: 1000, tot: 200, moved: 190 }] };
      },
    };
    const out = await detectSnapshotMeasures(q, fin, [], finProfiles, new Map());
    expect(out.get('accounts balance')?.signal).toBe('carry-forward');
    expect(out.get('accounts balance')?.vnRatio).toBeCloseTo(0.003, 5);
    expect(out.has('transactions amount')).toBe(false);
  });
});
