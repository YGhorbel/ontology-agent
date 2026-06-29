/**
 * Stage 3a.5 — tier-1 operation⇒grain resolver (ADR-016). No LLM, no DB.
 *
 * Payloads are REAL Stage-2 payloads over the committed formula1 fixture (via `payloadFor` + `f1Graph`),
 * so the temporality tags (`constructorstandings.points` cumulative-snapshot, the per-event siblings
 * untagged) and the FK-symmetry (`constructorresults`↔`constructorstandings`, both → `constructors`) are
 * the genuine generated/structural signal — not mocks. One SYNTHETIC, non-F1 graph proves the
 * standings-pick (and the as-of-event-snapshot branch) generalizes with no hardcoded names.
 *
 * The resolver's signature is `resolveGrain(ir, payload, graph)` — the question string is NOT in scope,
 * so a lexical cue CANNOT leak in. That is the structural H4 guarantee; the surface tests assert it by
 * construction.
 */
import { describe, it, expect } from 'vitest';
import { resolveGrain, classifyOperationShape } from '../../src/query/grain-resolve.js';
import { compile } from '../../src/query/compiler.js';
import type { MetricQueryIR } from '../../src/query/ir.js';
import type { OntologyGraph, JoinEdge, SubgraphPayload } from '../../src/query/graph-model.js';
import { datatypePropertyIri, classIri } from '../../src/types/ontology.js';
import { payloadFor, prop, f1Graph, ir1, irProjection } from '../fixtures/ir/index.js';

// Both points siblings present + anchored (the post-sibling-survival BOTH-PRESENT payload).
const pointsPayload = payloadFor(['constructorresults', 'constructorstandings'], {
  anchored: { constructorresults: ['points'], constructorstandings: ['points'], constructors: ['name'] },
});
// + races so an event-key (raceid) filter is a real join-key pin, and `year` is orderable.
const pointsWithRaces = payloadFor(['constructorresults', 'constructorstandings', 'races'], {
  anchored: {
    constructorresults: ['points'],
    constructorstandings: ['points'],
    constructors: ['name'],
    races: ['year', 'round'],
  },
});

const CR_POINTS = prop('constructorresults', 'points');
const CS_POINTS = prop('constructorstandings', 'points');

describe('grain-resolve — operation-shape extraction (from IR structure alone)', () => {
  it('AGG_OVER_EVENTS: SUM of the grain column with GROUP BY, no event pin', () => {
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'SUM', property: CS_POINTS }, alias: 'pts' }],
      groupBy: [{ property: prop('constructors', 'name') }],
    };
    expect(classifyOperationShape(ir, 'points', pointsPayload)).toBe('AGG_OVER_EVENTS');
  });

  it('MAX_OR_LATEST_UNPINNED: ORDER BY the grain column + LIMIT, no event pin', () => {
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      orderBy: [{ byProperty: CR_POINTS, dir: 'DESC' }],
      limit: 1,
    };
    expect(classifyOperationShape(ir, 'points', pointsPayload)).toBe('MAX_OR_LATEST_UNPINNED');
  });

  it('ASOF_EVENT_FILTER: equality on the event-key join column pins a single event — points=0 alone is NOT a pin', () => {
    // raceid is a join-key column name; points is the grain column (a value filter, not a pin).
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      filters: [
        { property: prop('constructorstandings', 'points'), op: '=', value: 0 },
        { property: prop('constructorstandings', 'raceid'), op: '=', value: 291 },
      ],
    };
    expect(classifyOperationShape(ir, 'points', pointsWithRaces)).toBe('ASOF_EVENT_FILTER');

    // The same IR WITHOUT the raceId pin (only points=0) is NOT ASOF — points is not a join key.
    const noPin: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      filters: [{ property: prop('constructorstandings', 'points'), op: '=', value: 0 }],
    };
    expect(classifyOperationShape(noPin, 'points', pointsWithRaces)).not.toBe('ASOF_EVENT_FILTER');
  });

  it('ASOF_EVENT_FILTER (case 869): a CALENDAR equality (round=9) pins the event even when ORDER BY is on the grain column', () => {
    // The planner expresses the pin as `races.round = 9` (a calendar/evidence column), not `raceId = 9`.
    // Without catching it, this would mis-classify as MAX (ORDER BY points DESC LIMIT 1) and wrongly resolve.
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      filters: [{ property: prop('races', 'round'), op: '=', value: 9 }],
      orderBy: [{ byProperty: CS_POINTS, dir: 'DESC' }],
      limit: 1,
    };
    expect(classifyOperationShape(ir, 'points', pointsWithRaces)).toBe('ASOF_EVENT_FILTER');
    // …and the resolver SURFACES it (flags), leaving the planner's binding untouched — never a MAX rebind.
    const { ir: out, trace } = resolveGrain(ir, pointsWithRaces, f1Graph);
    expect(out).toEqual(ir);
    expect(trace.resolutions).toEqual([]);
    expect(trace.ambiguities[0]).toMatchObject({ column: 'points', shape: 'ASOF_EVENT_FILTER' });
  });

  it('ASOF_EVENT_FILTER: order-then-LIMIT-1 by a NON-grain column (the as-of row) pins a single event', () => {
    const ir: MetricQueryIR = {
      select: [{ property: CS_POINTS }],
      orderBy: [{ byProperty: prop('races', 'year'), dir: 'ASC' }],
      limit: 1,
    };
    expect(classifyOperationShape(ir, 'points', pointsWithRaces)).toBe('ASOF_EVENT_FILTER');
  });
});

describe('grain-resolve — resolve (separable shapes bind the operation-implied sibling)', () => {
  it('AGG ⇒ per-event: a planner mis-pick of the cumulative sibling is rebound to the per-event sibling', () => {
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'SUM', property: CS_POINTS }, alias: 'pts' }],
      groupBy: [{ property: prop('constructors', 'name') }],
    };
    const { ir: out, trace } = resolveGrain(ir, pointsPayload, f1Graph);
    expect(out.measures![0]!.aggExpr!.property).toBe(CR_POINTS);
    expect(trace.resolutions).toEqual([
      { column: 'points', from: 'constructorstandings', to: 'constructorresults', shape: 'AGG_OVER_EVENTS', impliedGrain: 'per-event' },
    ]);
    expect(trace.ambiguities).toEqual([]);
  });

  it('AGG already per-event ⇒ no-op (the IR is not churned)', () => {
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'SUM', property: CR_POINTS }, alias: 'pts' }],
      groupBy: [{ property: prop('constructors', 'name') }],
    };
    const { ir: out, trace } = resolveGrain(ir, pointsPayload, f1Graph);
    expect(out).toEqual(ir);
    expect(trace.resolutions).toEqual([]);
  });

  it('MAX ⇒ standings: a planner mis-pick of the per-event sibling is rebound to the cumulative sibling', () => {
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      orderBy: [{ byProperty: CR_POINTS, dir: 'DESC' }],
      limit: 1,
    };
    const { ir: out, trace } = resolveGrain(ir, pointsPayload, f1Graph);
    expect(out.orderBy![0]!.byProperty).toBe(CS_POINTS);
    expect(trace.resolutions[0]).toMatchObject({ column: 'points', from: 'constructorresults', to: 'constructorstandings', shape: 'MAX_OR_LATEST_UNPINNED', impliedGrain: 'standings' });
  });
});

// ── SYNTHETIC, non-F1 generality: FK-symmetric (teamstate ↔ teamevent, both → team) `rank` siblings,
//    one as-of-event-snapshot, one per-event. Proves the standings-pick (and the as-of-event-snapshot
//    branch) is general, with NO hardcoded names. ──
function syntheticRankFixture(): { graph: OntologyGraph; payload: SubgraphPayload } {
  const team = classIri('team');
  const state = classIri('teamstate'); // as-of-event-snapshot rank (the standing)
  const event = classIri('teamevent'); // per-event rank (untagged)
  const edge = (from: string, to: string): JoinEdge => ({
    from, to, weight: 1, confidence: 1, provenance: 'declared',
    columnPairs: [{ fromCol: 'teamid', toCol: 'teamid' }], domain: from, range: to, sourceIri: `${from}#fk`,
  });
  const graph: OntologyGraph = {
    nodes: new Map([
      [team, { iri: team, table: 'team', properties: [{ col: 'teamid', isPrimaryKey: true }] }],
      [state, { iri: state, table: 'teamstate', properties: [{ col: 'teamid' }, { col: 'rank', temporality: 'as-of-event-snapshot' }] }],
      [event, { iri: event, table: 'teamevent', properties: [{ col: 'teamid' }, { col: 'rank' }] }],
    ]),
    adjacency: new Map([
      [team, [edge(team, state), edge(team, event)]],
      [state, [edge(state, team)]],
      [event, [edge(event, team)]],
    ]),
  };
  const payload: SubgraphPayload = {
    classes: [
      { iri: state, properties: [{ col: 'teamid' }, { col: 'rank', temporality: 'as-of-event-snapshot' }] },
      { iri: event, properties: [{ col: 'teamid' }, { col: 'rank' }] },
      { iri: team, properties: [{ col: 'teamid', isPrimaryKey: true }] },
    ],
    joins: [
      { from: state, to: team, on: [['teamid', 'teamid']], provenance: 'declared', confidence: 1 },
      { from: event, to: team, on: [['teamid', 'teamid']], provenance: 'declared', confidence: 1 },
    ],
    capabilities: [], aggregateConfidence: 1, bridgeNodes: [], totalCost: 2,
  };
  return { graph, payload };
}

describe('grain-resolve — generality: as-of-event-snapshot standings-pick on a synthetic non-F1 schema', () => {
  it('MAX over a per-event column is rebound to the FK-symmetric as-of-event-snapshot sibling', () => {
    const { graph, payload } = syntheticRankFixture();
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'MAX', property: datatypePropertyIri('teamevent', 'rank') }, alias: 'best' }],
    };
    const { ir: out, trace } = resolveGrain(ir, payload, graph);
    expect(out.measures![0]!.aggExpr!.property).toBe(datatypePropertyIri('teamstate', 'rank'));
    expect(trace.resolutions[0]).toMatchObject({ column: 'rank', from: 'teamevent', to: 'teamstate', impliedGrain: 'standings' });
  });
});

describe('grain-resolve — surface (irreducible ASOF: detect + flag, never pick)', () => {
  it('ASOF raises grainAmbiguous with both candidates and leaves the IR untouched (no rewrite, no lexical cue)', () => {
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      filters: [
        { property: prop('constructorstandings', 'points'), op: '=', value: 0 },
        { property: prop('constructorstandings', 'raceid'), op: '=', value: 291 },
      ],
    };
    const { ir: out, trace } = resolveGrain(ir, pointsWithRaces, f1Graph);
    expect(out).toEqual(ir); // nothing rewritten — the planner's binding is kept
    expect(trace.resolutions).toEqual([]);
    expect(trace.ambiguities).toHaveLength(1);
    expect(trace.ambiguities[0]).toMatchObject({ column: 'points', shape: 'ASOF_EVENT_FILTER' });
    const tables = trace.ambiguities[0]!.candidates.map((c) => c.table).sort();
    expect(tables).toContain('constructorresults');
    expect(tables).toContain('constructorstandings');
  });
});

describe('grain-resolve — composition with back-prune (ADR-012)', () => {
  it('after the resolver picks one sibling, the compiled FROM drops the other (no over-join)', () => {
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'SUM', property: CS_POINTS }, alias: 'pts' }],
      groupBy: [{ property: prop('constructors', 'name') }],
    };
    const { ir: resolved } = resolveGrain(ir, pointsPayload, f1Graph);
    const { sql } = compile(resolved, pointsPayload);
    expect(sql).toContain('constructorresults.points');
    expect(sql).not.toContain('constructorstandings'); // the unreferenced sibling leaf is pruned
  });
});

describe('grain-resolve — non-regression (no grain competitor ⇒ no-op)', () => {
  it('an IR referencing no grain-competitor column is returned unchanged with an empty trace', () => {
    const payload = payloadFor(['laptimes', 'constructors'], { anchored: { constructors: ['nationality'] } });
    const { ir: out, trace } = resolveGrain(ir1, payload, f1Graph);
    expect(out).toEqual(ir1);
    expect(trace.resolutions).toEqual([]);
    expect(trace.ambiguities).toEqual([]);
  });

  it('a projection IR with no competitor column is untouched', () => {
    const payload = payloadFor(['circuits'], { anchored: { circuits: ['lat', 'lng', 'name'] } });
    const { ir: out, trace } = resolveGrain(irProjection, payload, f1Graph);
    expect(out).toEqual(irProjection);
    expect(trace.resolutions.length + trace.ambiguities.length).toBe(0);
  });

  it('a per-event points column with NO FK-symmetric sibling in scope is untouched (no entity swap)', () => {
    // driverstandings.points (cumulative) shares the NAME `points` with constructorresults/constructorstandings,
    // but is FK-symmetric to neither (→drivers, not →constructors) — so a SUM is left exactly as the planner bound it.
    const payload = payloadFor(['driverstandings', 'constructorresults'], {
      anchored: { driverstandings: ['points'], constructorresults: ['points'] },
    });
    const ir: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'SUM', property: prop('driverstandings', 'points') }, alias: 'pts' }],
    };
    const { ir: out, trace } = resolveGrain(ir, payload, f1Graph);
    expect(out).toEqual(ir);
    expect(trace.resolutions).toEqual([]);
  });
});
