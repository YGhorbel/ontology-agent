import { describe, it, expect } from 'vitest';
import { linkQuestion } from '../../src/query/schema-linker.js';
import { buildJoinGraph, resolveJoinPath } from '../../src/query/join-graph.js';
import { intentToSql } from '../../src/query/intent-to-sql.js';
import { QueryIntentSchema } from '../../src/types/query-intent.js';
import { f1Index, ecommerceIndex, type GoldenCase } from '../fixtures/golden-questions.js';
import type { OntologyIndex } from '../../src/query/ontology-index.js';

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
