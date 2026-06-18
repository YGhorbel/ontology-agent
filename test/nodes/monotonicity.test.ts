import { describe, it, expect } from 'vitest';
import {
  detectCumulativeMeasures,
  deriveSequencePlan,
  buildMonotonicQuery,
  isCalendarTable,
} from '../../src/profiling/monotonicity.js';
import type { CanonicalSchema, Table } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { ForeignKeyCandidate } from '../../src/types/foreign-key-candidate.js';
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
      columns: [col('driverstandingsid', 'bigint'), col('raceid', 'bigint'), col('driverid', 'bigint'), col('points', 'real'), col('wins', 'bigint')],
      sampleRows: [],
      numericStats: [],
    },
  ],
  foreignKeys: [{ name: 'ds_driverid_fkey', sourceTable: 'driverstandings', sourceColumn: 'driverid', targetTable: 'drivers', targetColumn: 'driverid', onDelete: 'NO ACTION' }],
};

const profile = (table: string, column: string, uniquenessRatio: number | null): ColumnProfile => ({
  table,
  column,
  dataType: 'real',
  numRows: 100,
  nullCount: 0,
  nullRatio: 0,
  distinctCount: 50,
  uniquenessRatio,
  min: '0',
  max: '100',
});

describe('isCalendarTable', () => {
  it('recognises a table with a season group + round/date order', () => {
    expect(isCalendarTable(schema.tables[1]!)).toBe(true); // races
    expect(isCalendarTable(schema.tables[0]!)).toBe(false); // drivers
  });
});

describe('deriveSequencePlan', () => {
  it('joins the calendar table, partitions by entity + season, orders by round', () => {
    const plan = deriveSequencePlan(schema.tables[2]!, schema, []);
    expect(plan?.joinTable).toBe('races');
    expect(plan?.joinFromColumn).toBe('raceid');
    expect(plan?.entityColumns).toEqual(['driverid']);
    expect(plan?.groupColumn).toBe('year');
    expect(plan?.orderColumn).toBe('round');
  });

  it('Part 2a: excludes a low-confidence discovered FK on an ordinal column from the partition', () => {
    // `position` IS-A ⊆ B coincidence the discoverer surfaces with a tiny score. Including it would
    // over-partition the series and make a non-cumulative measure look monotonic. It must be dropped.
    const noisyPositionFk: ForeignKeyCandidate = {
      kind: 'foreign-key', sourceTable: 'driverstandings', sourceColumn: 'position', targetTable: 'drivers', targetColumn: 'driverid',
      junctionTable: null, cardinality: 'many-to-many', verified: true, containmentRatio: 0.8, score: 0.05, declared: false, evidence: 'ind',
      signals: { nameSimilarity: 0, surrogate: false, rhsReferences: 1 },
    };
    const plan = deriveSequencePlan(schema.tables[2]!, schema, [noisyPositionFk]);
    expect(plan?.entityColumns).toEqual(['driverid']); // position excluded
  });
});

describe('buildMonotonicQuery', () => {
  it('partitions by entity + season and orders by the calendar column', () => {
    const plan = deriveSequencePlan(schema.tables[2]!, schema, [])!;
    const sql = buildMonotonicQuery('driverstandings', 'points', plan);
    expect(sql).toContain('PARTITION BY t."driverid", r."year"');
    expect(sql).toContain('ORDER BY r."round"');
    expect(sql).toContain('JOIN "races" r ON t."raceid" = r."raceid"');
  });
});

describe('detectCumulativeMeasures', () => {
  const fks: ForeignKeyCandidate[] = [];
  it('tags a monotonic measure as cumulative-snapshot', async () => {
    const profiles = [profile('driverstandings', 'points', 0.4), profile('driverstandings', 'wins', 0.1)];
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (text.includes('"points"')) return { rows: [{ neg: 0, tot: 90 }] };
        if (text.includes('"wins"')) return { rows: [{ neg: 0, tot: 90 }] };
        return { rows: [{ neg: 0, tot: 0 }] };
      },
    };
    const out = await detectCumulativeMeasures(q, schema, fks, profiles);
    expect(out.has('driverstandings points')).toBe(true);
    expect(out.has('driverstandings wins')).toBe(true);
    expect(out.get('driverstandings points')?.partitionColumns).toEqual(['driverid', 'year']);
  });

  it('does not tag a non-monotonic measure', async () => {
    const profiles = [profile('driverstandings', 'points', 0.4)];
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        return { rows: [{ neg: 40, tot: 90 }] };
      },
    };
    const out = await detectCumulativeMeasures(q, schema, fks, profiles);
    expect(out.has('driverstandings points')).toBe(false);
  });
});
