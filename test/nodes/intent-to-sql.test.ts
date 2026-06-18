import { describe, it, expect } from 'vitest';
import { linkQuestion } from '../../src/query/schema-linker.js';
import { buildJoinGraph, resolveJoinPath } from '../../src/query/join-graph.js';
import { intentToSql } from '../../src/query/intent-to-sql.js';
import { QueryIntentSchema } from '../../src/types/query-intent.js';
import { f1Index, ecommerceIndex, type GoldenCase } from '../fixtures/golden-questions.js';
import type { OntologyIndex, ColumnInfo, CapabilityInfo } from '../../src/query/ontology-index.js';

function planFor(index: OntologyIndex, tables: string[]): ReturnType<typeof resolveJoinPath> {
  const graph = buildJoinGraph(index.joinEdges);
  const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
  return resolveJoinPath(graph, tables, { factTables });
}

function sqlFor(question: string, index: GoldenCase['index']): { sql: string; warnings: string[] } {
  const intent = linkQuestion(question, index);
  return intentToSql(intent, planFor(index, intent.tables), index);
}

/** Whitespace-insensitive contains. */
const has = (sql: string, frag: string): boolean => sql.replace(/\s+/g, ' ').includes(frag);

describe('intentToSql', () => {
  it('renders an aggregate from the capability formula + a value filter, no GROUP BY', () => {
    const { sql, warnings } = sqlFor('total points for British constructors', f1Index);
    expect(has(sql, 'SELECT SUM(results.points)')).toBe(true);
    expect(sql).toMatch(/FROM results/);
    expect(sql).toMatch(/JOIN constructors ON/);
    expect(sql).toMatch(/WHERE constructors\.nationality = '/); // string literal quoted
    expect(sql).not.toMatch(/GROUP BY/); // nothing non-aggregated to group on
    // results→constructors is one-to-many: an aggregate over it can double-count.
    expect(warnings.some((w) => w.includes('double-count'))).toBe(true);
  });

  it('renders a dimension + COUNT with a matching GROUP BY', () => {
    const { sql } = sqlFor('order count by currency', ecommerceIndex);
    expect(has(sql, 'SELECT orders.currency, COUNT(orders.id) AS order_count')).toBe(true);
    expect(sql).toMatch(/GROUP BY orders\.currency/);
  });

  it('renders a ranking query: projection + ORDER BY DESC + LIMIT, no aggregate', () => {
    const { sql } = sqlFor('what is the family name of the driver with the fastest lap speed', f1Index);
    expect(has(sql, 'SELECT')).toBe(true);
    expect(sql).toMatch(/drivers\.surname/);
    expect(sql).toMatch(/ORDER BY results\.fastestlapspeed DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(sql).not.toMatch(/GROUP BY/);
    expect(sql).not.toMatch(/AVG\(/); // the metric is ranked, not aggregated
  });

  it('leaves a numeric filter unquoted and emits a single-table FROM with no JOIN', () => {
    const { sql } = sqlFor('race number 20', f1Index);
    expect(sql).toMatch(/FROM races/);
    expect(sql).not.toMatch(/JOIN/);
    expect(sql).toMatch(/WHERE races\.raceid = 20\b/); // bare integer, no quotes
    expect(sql).not.toMatch(/'20'/);
  });

  it('warns when the join graph leaves a requested table unreachable', () => {
    const intent = QueryIntentSchema.parse({
      question: 'x',
      tables: ['results', 'orphan'],
      measures: [],
      groupDims: [],
      filters: [],
      ambiguities: [],
      unresolved: [],
    });
    const plan = { anchorTable: 'results', clauses: [], unreachable: ['orphan'], lowConfidence: false, fanOut: false };
    const { warnings } = intentToSql(intent, plan, f1Index);
    expect(warnings.some((w) => w.includes('unreachable') && w.includes('orphan'))).toBe(true);
  });

  it('falls back to SELECT * (with a warning) when nothing linked into the SELECT', () => {
    const intent = QueryIntentSchema.parse({
      question: 'x',
      tables: ['drivers'],
      measures: [],
      groupDims: [],
      filters: [],
      ambiguities: [],
      unresolved: [],
    });
    const { sql, warnings } = intentToSql(intent, planFor(f1Index, ['drivers']), f1Index);
    expect(sql).toMatch(/SELECT \*/);
    expect(warnings.some((w) => w.includes('SELECT *'))).toBe(true);
  });
});

describe('intentToSql — cumulative & provenance awareness (ontology-signal wiring)', () => {
  const col = (o: Partial<ColumnInfo>): ColumnInfo => ({ column: 'points', prefLabel: 'Points', altLabel: [], comment: '', ...o });
  /** Minimal index carrying just the columns + capabilities intentToSql reads. */
  const makeIndex = (columns: Record<string, ColumnInfo[]>, capabilities: CapabilityInfo[] = []): OntologyIndex => ({
    classes: new Map(),
    columnsByTable: new Map(Object.entries(columns)),
    capabilities,
    joinEdges: [],
  });
  const measureIntent = (table: string, column: string, capability?: string) =>
    QueryIntentSchema.parse({
      question: 'q', tables: [table],
      measures: [{ table, column, ...(capability ? { capability } : {}) }],
      groupDims: [], filters: [], ambiguities: [], unresolved: [],
    });
  const singleTablePlan = (t: string) => ({ anchorTable: t, clauses: [], unreachable: [], lowConfidence: false, fanOut: false });

  it('aggregates a cumulative-snapshot column with MAX, not SUM, and warns on the grain', () => {
    const index = makeIndex({
      driverstandings: [col({ column: 'points', temporality: 'cumulative-snapshot', temporalityEvidence: { partitionColumns: ['driverid', 'year'], orderColumn: 'round', ratio: 1 } })],
    });
    const { sql, warnings } = intentToSql(measureIntent('driverstandings', 'points'), singleTablePlan('driverstandings'), index);
    expect(sql).toMatch(/MAX\(driverstandings\.points\)/);
    expect(sql).not.toMatch(/SUM\(driverstandings\.points\)/);
    expect(warnings.some((w) => w.includes('cumulative snapshot') && w.includes('driverid, year') && w.includes('round'))).toBe(true);
  });

  it('still uses SUM for a plain (non-cumulative) numeric measure', () => {
    const index = makeIndex({ results: [col({ column: 'points' })] });
    const { sql, warnings } = intentToSql(measureIntent('results', 'points'), singleTablePlan('results'), index);
    expect(sql).toMatch(/SUM\(results\.points\)/);
    expect(warnings.some((w) => w.includes('cumulative'))).toBe(false);
  });

  it('warns when a measure relies on an LLM-inferred (unvalidated) metric formula', () => {
    const index = makeIndex(
      { results: [col({ column: 'points' })] },
      [{ kind: 'metric', scopeTable: 'results', scopeColumn: 'points', prefLabel: 'total points', altLabel: [], formulaHint: 'SUM(results.points)', provenance: 'llm' }],
    );
    const { warnings } = intentToSql(measureIntent('results', 'points', 'total points'), singleTablePlan('results'), index);
    expect(warnings.some((w) => w.includes('total points') && w.includes('not dry-run-validated'))).toBe(true);
  });

  it('does not warn for a validated (llm-validated) metric formula', () => {
    const index = makeIndex(
      { results: [col({ column: 'points' })] },
      [{ kind: 'metric', scopeTable: 'results', scopeColumn: 'points', prefLabel: 'total points', altLabel: [], formulaHint: 'SUM(results.points)', provenance: 'llm-validated' }],
    );
    const { warnings } = intentToSql(measureIntent('results', 'points', 'total points'), singleTablePlan('results'), index);
    expect(warnings.some((w) => w.includes('not dry-run-validated'))).toBe(false);
  });
});
