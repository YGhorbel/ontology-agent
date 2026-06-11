import { describe, it, expect } from 'vitest';
import {
  checkFormulaStatic,
  checkFormulaDryRun,
  referencedColumns,
  parseFormula,
} from '../../src/validation/formula-validator.js';
import type { CanonicalSchema } from '../../src/types/canonical-schema.js';
import type { ColumnFact } from '../../src/types/column-fact.js';
import type { Queryable } from '../../src/storage/pg.js';

const schema: CanonicalSchema = {
  datasourceId: 'f1',
  tables: [
    {
      name: 'results',
      comment: null,
      columns: [
        { name: 'resultid', type: 'bigint', nullable: false, default: null, comment: null, position: 1 },
        { name: 'points', type: 'real', nullable: true, default: null, comment: null, position: 2 },
        { name: 'fastestlapspeed', type: 'text', nullable: true, default: null, comment: null, position: 3 },
      ],
      sampleRows: [],
      numericStats: [],
    },
  ],
  foreignKeys: [],
};

const fact = (column: string, o: Partial<ColumnFact> = {}): ColumnFact => ({
  table: 'results',
  column,
  dataType: 'text',
  isNumericText: false,
  isUnique: false,
  isPrimaryKey: false,
  distinctCount: null,
  nullable: true,
  sampleValues: [],
  ...o,
});

describe('formula static checks', () => {
  it('flags a reference to a nonexistent column (bind)', () => {
    const res = checkFormulaStatic({ subject: 'cap:x', formula: 'SUM(results.nonexistent)', unit: 'count', scopeTable: 'results', schema, columnFacts: [] });
    expect(res.errors.some((e) => e.rule === 'formula-bind')).toBe(true);
  });

  it('flags an aggregate over a numeric-text column with no CAST (type)', () => {
    const facts = [fact('fastestlapspeed', { isNumericText: true })];
    const res = checkFormulaStatic({ subject: 'cap:x', formula: 'AVG(results.fastestlapspeed)', unit: 'kph', scopeTable: 'results', schema, columnFacts: facts });
    expect(res.errors.some((e) => e.rule === 'formula-type')).toBe(true);
  });

  it('accepts AVG(CAST(results.fastestlapspeed AS DOUBLE PRECISION))', () => {
    const facts = [fact('fastestlapspeed', { isNumericText: true })];
    const res = checkFormulaStatic({ subject: 'cap:x', formula: 'AVG(CAST(results.fastestlapspeed AS DOUBLE PRECISION))', unit: 'kph', scopeTable: 'results', schema, columnFacts: facts });
    expect(res.errors).toEqual([]);
    expect(res.passed).toContain('parse');
    expect(res.passed).toContain('bind');
  });

  it('flags an unparseable formula', () => {
    const res = checkFormulaStatic({ subject: 'cap:x', formula: 'SUM(', unit: 'count', scopeTable: 'results', schema, columnFacts: [] });
    expect(res.errors.some((e) => e.rule === 'formula-parse')).toBe(true);
  });

  it('extracts qualified column references', () => {
    expect(parseFormula('SUM(results.points)')).not.toBeNull();
    expect(referencedColumns('SUM(results.points) - results.resultid')).toEqual(
      expect.arrayContaining([
        { table: 'results', column: 'points' },
        { table: 'results', column: 'resultid' },
      ]),
    );
  });
});

describe('formula dry-run', () => {
  it('flags a non-numeric result when the unit is numeric-like', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        return { rows: [{ t: 'text' }] };
      },
    };
    const res = await checkFormulaDryRun(q, { subject: 'cap:x', formula: "results.fastestlapspeed", unit: 'kph', scopeTable: 'results', schema, columnFacts: [] });
    expect(res.errors.some((e) => e.rule === 'formula-type')).toBe(true);
  });

  it('flags an execution error as formula-dry-run', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        throw new Error('column does not exist');
      },
    };
    const res = await checkFormulaDryRun(q, { subject: 'cap:x', formula: 'SUM(results.points)', unit: 'count', scopeTable: 'results', schema, columnFacts: [] });
    expect(res.errors.some((e) => e.rule === 'formula-dry-run')).toBe(true);
  });

  it('passes a numeric result', async () => {
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        return { rows: [{ t: 'numeric' }] };
      },
    };
    const res = await checkFormulaDryRun(q, { subject: 'cap:x', formula: 'SUM(results.points)', unit: 'count', scopeTable: 'results', schema, columnFacts: [] });
    expect(res.errors).toEqual([]);
    expect(res.passed).toContain('dry-run');
    expect(res.passed).toContain('type');
  });
});
