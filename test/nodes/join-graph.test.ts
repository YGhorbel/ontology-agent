import { describe, it, expect } from 'vitest';
import {
  buildJoinGraph,
  resolveJoinPath,
  resolveAllPaths,
  synthesizeCoReferenceEdges,
} from '../../src/query/join-graph.js';
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
  extraColumns: [],
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
    expect(c.on).toHaveLength(1);
    const pair = [c.on[0]!.left, c.on[0]!.right].sort();
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
      const left = c.on[0]!.left.split('.')[0]!;
      const right = c.on[0]!.right.split('.')[0]!;
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
    const pair = [plan.clauses[0]!.on[0]!.left, plan.clauses[0]!.on[0]!.right].sort();
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
    expect(plan.clauses.some((cl) => cl.on.some((p) => p.left.includes('.qty') || p.right.includes('.qty')))).toBe(false);
  });

  it('reports tables with no join path as unreachable', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results', 'status']); // status has no edge
    expect(plan.unreachable).toContain('status');
  });

  it('returns an empty plan for a single table', () => {
    const g = buildJoinGraph(f1());
    const plan = resolveJoinPath(g, ['results']);
    expect(plan).toEqual({ anchorTable: 'results', clauses: [], unreachable: [], lowConfidence: false, fanOut: false });
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

  it('flags a row-multiplying hop as fan-out; a one-to-one hop is clean', () => {
    const many = resolveJoinPath(buildJoinGraph([edge('a', 'b_id', 'b', 'id', { cardinality: 'one-to-many' })]), ['a', 'b']);
    expect(many.clauses[0]!.multiplies).toBe(true);
    expect(many.fanOut).toBe(true);

    const one = resolveJoinPath(buildJoinGraph([edge('a', 'b_id', 'b', 'id', { cardinality: 'one-to-one' })]), ['a', 'b']);
    expect(one.clauses[0]!.multiplies).toBe(false);
    expect(one.fanOut).toBe(false);
  });
});

describe('synthesizeCoReferenceEdges', () => {
  it('joins two siblings sharing >=2 FK parents on the shared keys', () => {
    const synth = synthesizeCoReferenceEdges(f1()); // qualifying & results both -> races, drivers
    expect(synth).toHaveLength(1);
    const e = synth[0]!;
    expect(e.provenance).toBe('co-reference');
    expect(e.cardinality).toBe('many-to-many');
    expect([e.fromTable, e.toTable].sort()).toEqual(['qualifying', 'results']);
    // composite: a primary + one extra key pair, covering raceid AND driverid
    const cols = [e.fromColumn, ...e.extraColumns.map((x) => x.from)].sort();
    expect(cols).toEqual(['driverid', 'raceid']);
  });

  it('does NOT synthesize when only one parent is shared', () => {
    const edges: JoinEdge[] = [
      edge('x', 'pid', 'p', 'id'),
      edge('y', 'pid', 'p', 'id'), // x and y share only p → fan-trap route, no co-ref
    ];
    expect(synthesizeCoReferenceEdges(edges)).toHaveLength(0);
  });

  it('still synthesizes when only a noise edge directly connects the siblings', () => {
    const synth = synthesizeCoReferenceEdges([
      ...f1(),
      // a 0.00-confidence coincidence directly between qualifying and results must NOT
      // count as "already joinable" and block the real co-reference.
      edge('qualifying', 'qualifyid', 'results', 'resultid', { confidence: 0, provenance: 'discovered' }),
    ]);
    expect(synth).toHaveLength(1);
    expect([synth[0]!.fromTable, synth[0]!.toTable].sort()).toEqual(['qualifying', 'results']);
  });

  it('does NOT synthesize on below-floor (noise) FKs', () => {
    const edges: JoinEdge[] = [
      edge('x', 'a', 'p', 'id', { confidence: 0.05, provenance: 'discovered' }),
      edge('x', 'b', 'q', 'id', { confidence: 0.05, provenance: 'discovered' }),
      edge('y', 'a', 'p', 'id', { confidence: 0.05, provenance: 'discovered' }),
      edge('y', 'b', 'q', 'id', { confidence: 0.05, provenance: 'discovered' }),
    ];
    expect(synthesizeCoReferenceEdges(edges)).toHaveLength(0);
  });
});

describe('resolveJoinPath — composite co-reference', () => {
  it('joins sibling fact tables directly on both shared keys, not via a dimension', () => {
    const plan = resolveJoinPath(buildJoinGraph(f1()), ['qualifying', 'results']);
    expect(plan.unreachable).toEqual([]);
    expect(plan.clauses).toHaveLength(1); // direct, not a 2-hop detour
    const c = plan.clauses[0]!;
    expect(c.provenance).toBe('co-reference');
    expect(c.on).toHaveLength(2); // raceid AND driverid
    const cols = c.on.map((p) => `${p.left}=${p.right}`).sort();
    expect(cols).toEqual(['qualifying.driverid=results.driverid', 'qualifying.raceid=results.raceid']);
    expect(plan.fanOut).toBe(true);
  });
});

describe('resolveAllPaths (K-best candidates)', () => {
  it('returns ranked candidates with the co-reference route on top', () => {
    const cands = resolveAllPaths(buildJoinGraph(f1()), ['qualifying', 'results'], { k: 5 });
    expect(cands.length).toBeGreaterThanOrEqual(2); // co-ref + dimension detours
    const top = cands[0]!;
    expect(top.hops).toBe(1);
    expect(top.provenanceMix).toContain('co-reference');
    // each candidate carries the LLM-facing decision signals
    for (const c of cands) {
      expect(typeof c.score).toBe('number');
      expect(c.totalConfidence).toBeGreaterThan(0);
      expect(typeof c.fanOut).toBe('boolean');
    }
    // a multi-hop alternative is offered too
    expect(cands.some((c) => c.hops >= 2)).toBe(true);
  });

  it('returns [] for anything other than exactly two tables', () => {
    const g = buildJoinGraph(f1());
    expect(resolveAllPaths(g, ['results'])).toEqual([]);
    expect(resolveAllPaths(g, ['results', 'drivers', 'races'])).toEqual([]);
  });
});
