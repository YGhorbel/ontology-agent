import { describe, it, expect } from 'vitest';
import { buildJoinGraph, resolveJoinPath } from '../../src/query/join-graph.js';
import type { JoinEdge } from '../../src/types/query-plan.js';

const edge = (
  fromTable: string,
  fromColumn: string,
  toTable: string,
  toColumn: string,
  o: Partial<JoinEdge> = {},
): JoinEdge => ({
  fromTable,
  fromColumn,
  toTable,
  toColumn,
  cardinality: 'one-to-many',
  confidence: 1,
  provenance: 'declared',
  ...o,
});

// formula1 subset
const f1 = (): JoinEdge[] => [
  edge('results', 'constructorid', 'constructors', 'constructorid'),
  edge('results', 'raceid', 'races', 'raceid'),
  edge('results', 'driverid', 'drivers', 'driverid'),
  edge('races', 'circuitid', 'circuits', 'circuitid'),
  edge('qualifying', 'raceid', 'races', 'raceid'),
  edge('qualifying', 'driverid', 'drivers', 'driverid'),
];

describe('resolveJoinPath', () => {
  it('resolves a one-hop join with the exact ON columns', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results', 'constructors']);

    expect(plan.unreachable).toEqual([]);
    expect(plan.clauses).toHaveLength(1);
    const c = plan.clauses[0]!;
    expect(c.joinTable).toBe('constructors');
    const pair = [c.on.left, c.on.right].sort();
    expect(pair).toEqual(['constructors.constructorid', 'results.constructorid']);
  });

  it('resolves a multi-hop path (drivers -> ... -> races -> circuits)', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['drivers', 'circuits']);

    expect(plan.unreachable).toEqual([]);
    const joined = new Set([plan.anchorTable, ...plan.clauses.map((c) => c.joinTable)]);
    // every hop on the path must be present, including the intermediates
    expect(joined.has('drivers')).toBe(true);
    expect(joined.has('races')).toBe(true);
    expect(joined.has('circuits')).toBe(true);
    // each clause attaches to an already-joined table
    const seen = new Set<string>([plan.anchorTable]);
    for (const c of plan.clauses) {
      const left = c.on.left.split('.')[0]!;
      const right = c.on.right.split('.')[0]!;
      expect(seen.has(left) || seen.has(right)).toBe(true);
      seen.add(c.joinTable);
    }
  });

  it('prefers a declared edge over a parallel lower-confidence discovered edge', () => {
    const edges: JoinEdge[] = [
      edge('a', 'b_id', 'b', 'id', { confidence: 1, provenance: 'declared' }),
      edge('a', 'b_ref', 'b', 'ref', { confidence: 0.78, provenance: 'discovered' }),
    ];
    const plan = resolveJoinPath(buildJoinGraph(edges), ['a', 'b']);
    expect(plan.clauses).toHaveLength(1);
    const pair = [plan.clauses[0]!.on.left, plan.clauses[0]!.on.right].sort();
    expect(pair).toEqual(['a.b_id', 'b.id']); // the declared edge's columns
  });

  it('prefers a two-hop declared path over a direct low-confidence coincidence', () => {
    const edges: JoinEdge[] = [
      edge('a', 'b_id', 'b', 'id', { confidence: 1, provenance: 'declared' }),
      edge('b', 'c_id', 'c', 'id', { confidence: 1, provenance: 'declared' }),
      // coincidental direct a->c discovered edge (low confidence) must NOT win
      edge('a', 'qty', 'c', 'id', { confidence: 0.5, provenance: 'discovered' }),
    ];
    const plan = resolveJoinPath(buildJoinGraph(edges), ['a', 'c']);
    const joined = new Set([plan.anchorTable, ...plan.clauses.map((cl) => cl.joinTable)]);
    expect(joined.has('b')).toBe(true); // routed through b, not the a.qty coincidence
    expect(plan.clauses.some((cl) => cl.on.left.includes('.qty') || cl.on.right.includes('.qty'))).toBe(false);
  });

  it('reports tables with no join path as unreachable', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results', 'status']); // status has no edge
    expect(plan.unreachable).toContain('status');
  });

  it('returns an empty plan for a single table', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results']);
    expect(plan).toEqual({ anchorTable: 'results', clauses: [], unreachable: [], lowConfidence: false });
  });

  it('stamps each clause with provenance and confidence', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results', 'constructors']);
    expect(plan.lowConfidence).toBe(false);
    expect(plan.clauses[0]).toMatchObject({ provenance: 'declared', confidence: 1 });
  });

  it('ignores a low-confidence edge when a trusted path exists', () => {
    const edges: JoinEdge[] = [
      edge('a', 'b_id', 'b', 'id', { confidence: 1 }),
      edge('b', 'c_id', 'c', 'id', { confidence: 1 }),
      edge('a', 'qty', 'c', 'id', { confidence: 0.2, provenance: 'discovered' }), // below the 0.5 floor
    ];
    const plan = resolveJoinPath(buildJoinGraph(edges), ['a', 'c']);
    expect(plan.lowConfidence).toBe(false);
    const joined = new Set([plan.anchorTable, ...plan.clauses.map((cl) => cl.joinTable)]);
    expect(joined.has('b')).toBe(true); // routed through b, the low-conf a->c never considered
  });

  it('falls back to a low-confidence edge only when nothing trusted connects', () => {
    const edges: JoinEdge[] = [edge('a', 'qty', 'b', 'id', { confidence: 0.2, provenance: 'discovered' })];
    const plan = resolveJoinPath(buildJoinGraph(edges), ['a', 'b']);
    expect(plan.unreachable).toEqual([]);
    expect(plan.lowConfidence).toBe(true);
    expect(plan.clauses[0]).toMatchObject({ provenance: 'discovered', confidence: 0.2 });
  });

  it('does not fall back when allowLowConfidenceFallback is false', () => {
    const edges: JoinEdge[] = [edge('a', 'qty', 'b', 'id', { confidence: 0.2, provenance: 'discovered' })];
    const plan = resolveJoinPath(buildJoinGraph(edges), ['a', 'b'], { allowLowConfidenceFallback: false });
    expect(plan.unreachable).toContain('b');
  });

  it('uses a requested fact table as the FROM anchor when provided', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results', 'drivers'], { factTables: ['results'] });
    expect(plan.anchorTable).toBe('results');
    expect(plan.unreachable).toEqual([]);
  });
});
