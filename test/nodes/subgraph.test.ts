/**
 * Stage 2 acceptance tests — Steiner subgraph extraction over the committed formula1 fixture.
 * No LLM, no DB. The fixture is eval/fixtures/ontologies/formula1-1781704520.jsonld (build 1781704520).
 *
 * NOTE on divergence from the original spec prose: on THIS fixture the declared-FK subgraph is a
 * single zero-cost connected component spanning all classes, so confidence-weighted routing always
 * returns an all-declared tree (composites only ever win in uniform mode). Tests 2, 4 and 6 therefore
 * assert the algorithm's REAL deterministic output and document where it differs from the prose.
 * See docs/experiments/h1-join-routing.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraph, loadCapabilities } from '../../src/query/graph-build.js';
import { extractSubgraph } from '../../src/query/subgraph.js';
import type { OntologyGraph } from '../../src/query/graph-model.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const iri = (t: string): string => `qsl:class/${t}`;

/** Every source IRI present in the candidate region (must never appear in a built edge). */
function candidateIris(): Set<string> {
  const cg = (raw['qsl:candidateGraph'] as Array<Record<string, unknown>>) ?? [];
  return new Set(cg.map((c) => c['@id'] as string));
}
/** Source IRIs of every object property that carries a junctionTable (RULE A — must be excluded). */
function junctionIris(): Set<string> {
  const g = (raw['@graph'] as Array<Record<string, unknown>>) ?? [];
  return new Set(
    g
      .filter((n) => n['@type'] === 'owl:ObjectProperty' && n['qsl:junctionTable'] != null)
      .map((n) => n['@id'] as string),
  );
}
function allEdgeSourceIris(graph: OntologyGraph): Set<string> {
  const out = new Set<string>();
  for (const list of graph.adjacency.values()) for (const e of list) out.add(e.sourceIri);
  return out;
}
/** Canonical key for a payload join, for set comparison across modes. */
const joinKey = (j: { from: string; to: string; on: [string, string][] }): string =>
  `${j.from}->${j.to}:${j.on.map((p) => p.join('=')).join(',')}`;

const caps = loadCapabilities(raw);

describe('Stage 2 — graph build (RULES A/B/C, no candidate leakage)', () => {
  it('1. build sanity: 13 classes, no candidate/junction edges, composite is one edge w/ 2 pairs', () => {
    const graph = buildGraph(raw);
    expect(graph.nodes.size).toBe(13);

    const srcIris = allEdgeSourceIris(graph);
    // ZERO edges originate from the candidate graph.
    for (const c of candidateIris()) expect(srcIris.has(c)).toBe(false);
    // RULE A: the lone nm__ junction edge is excluded.
    const jIris = junctionIris();
    expect(jIris.size).toBe(1);
    for (const j of jIris) expect(srcIris.has(j)).toBe(false);

    // RULE B: results -> constructorstandings composite is ONE edge with 2 column pairs.
    const compIri = 'qsl:relationship/results/comp__constructorstandings';
    const compEdges = [...graph.adjacency.values()].flat().filter((e) => e.sourceIri === compIri);
    expect(compEdges.length).toBe(2); // forward + reverse adjacency copies of the SAME edge
    for (const e of compEdges) {
      expect(e.columnPairs.length).toBe(2);
      expect(e.confidence).toBeCloseTo(0.956, 2);
    }
    const fwd = compEdges.find((e) => e.from === iri('results'))!;
    expect(fwd.columnPairs.map((p) => p.fromCol).sort()).toEqual(['constructorid', 'raceid']);
  });
});

describe('Stage 2 — confidence-weighted routing', () => {
  // DIVERGENCE: spec prose expected laptimes->drivers->results->constructors (bridges drivers,results).
  // Real fixture: that route TIES at cost 0.0 with the qualifying route; both are all-declared.
  it('2a. winner invariants {laptimes, constructors}: cost 0, 3 declared edges, valid tree', () => {
    const graph = buildGraph(raw);
    const p = extractSubgraph(graph, [iri('laptimes'), iri('constructors')], [], caps);
    expect(p.totalCost).toBe(0);
    expect(p.joins.length).toBe(3);
    for (const j of p.joins) expect(j.provenance).toBe('declared');
    // valid tree: edges = nodes - 1, terminals present.
    const nodes = new Set(p.classes.map((c) => c.iri));
    expect(nodes.has(iri('laptimes'))).toBe(true);
    expect(nodes.has(iri('constructors'))).toBe(true);
    expect(p.joins.length).toBe(nodes.size - 1);
    expect(p.aggregateConfidence).toBe(1);
  });

  it('2b. tie-break selects the qualifying route (documented; tuning the tie-break breaks only this)', () => {
    const graph = buildGraph(raw);
    const p = extractSubgraph(graph, [iri('laptimes'), iri('constructors')], [], caps);
    expect(p.bridgeNodes).toEqual([iri('drivers'), iri('qualifying')]);
  });
});

describe('Stage 2 — H1 weighting flip (uniform vs confidence changes the CHOICE)', () => {
  it('3. uniform and confidence trees differ in their EDGE SET, not merely edge count', () => {
    const terminals = [iri('laptimes'), iri('constructors')];
    const confTree = extractSubgraph(buildGraph(raw), terminals, [], caps);
    const uniTree = extractSubgraph(buildGraph(raw, { uniform: true }), terminals, [], caps);

    const confSet = new Set(confTree.joins.map(joinKey));
    const uniSet = new Set(uniTree.joins.map(joinKey));
    // The claim is "weighting changed the choice": the chosen edge sets are not equal.
    expect([...uniSet].sort()).not.toEqual([...confSet].sort());

    // Uniform picks the 2-edge qualifying route; laptimes->qualifying is the composite (2 pairs).
    expect(uniTree.joins.length).toBe(2);
    expect(uniTree.bridgeNodes).toEqual([iri('qualifying')]);
    const lq = uniTree.joins.find(
      (j) =>
        (j.from === iri('laptimes') && j.to === iri('qualifying')) ||
        (j.from === iri('qualifying') && j.to === iri('laptimes')),
    )!;
    expect(lq.on.length).toBe(2); // composite, RULE B
    // Confidence picks the 3-edge declared route.
    expect(confTree.joins.length).toBe(3);
  });
});

describe('Stage 2 — composite as one atomic edge (RULE B selection)', () => {
  // RE-TARGETED: spec's {laptimes, constructorstandings} degenerates (a zero-cost declared path exists,
  // so no composite is ever chosen in confidence mode). {laptimes, driverstandings} demonstrates the
  // composite being selected when weighting favours fewer hops.
  it('4. uniform mode uses the 1-hop composite; confidence mode uses the 2-hop declared detour', () => {
    const terminals = [iri('laptimes'), iri('driverstandings')];

    const uni = extractSubgraph(buildGraph(raw, { uniform: true }), terminals, [], caps);
    expect(uni.joins.length).toBe(1);
    expect(uni.bridgeNodes).toEqual([]);
    const comp = uni.joins[0]!;
    expect(comp.on.length).toBe(2); // ONE atomic composite edge, 2 column pairs
    expect(comp.on.map((p) => p[0]).sort()).toEqual(['driverid', 'raceid']);
    expect(comp.provenance).toBe('discovered');

    const conf = extractSubgraph(buildGraph(raw), terminals, [], caps);
    expect(conf.joins.length).toBe(2);
    expect(conf.bridgeNodes).toEqual([iri('drivers')]);
    for (const j of conf.joins) {
      expect(j.provenance).toBe('declared');
      expect(j.on.length).toBe(1); // declared detour — no composite
    }
    expect(conf.totalCost).toBe(0);
  });
});

describe('Stage 2 — no candidate leakage', () => {
  it('5. no built edge is a candidate edge; no payload join uses a non-key junk column', () => {
    const graph = buildGraph(raw);
    const cand = candidateIris();
    for (const s of allEdgeSourceIris(graph)) expect(cand.has(s)).toBe(false);

    const sets: [string, string][] = [
      ['laptimes', 'constructors'],
      ['results', 'circuits'],
      ['pitstops', 'seasons'],
      ['constructorstandings', 'laptimes'],
    ];
    const keyish = /id$|^year$/; // legitimate join keys are id columns (or the year FK)
    for (const [a, b] of sets) {
      const p = extractSubgraph(graph, [iri(a), iri(b)], [], caps);
      for (const j of p.joins) {
        for (const [fc, tc] of j.on) {
          expect(fc).toMatch(keyish);
          expect(tc).toMatch(keyish);
        }
      }
    }
  });
});

describe('Stage 2 — single-terminal no-op + payload trimming', () => {
  it('6. {races} is a one-node no-op; bridge node columns are trimmed to join keys only', () => {
    const graph = buildGraph(raw);

    const solo = extractSubgraph(graph, [iri('races')], [], caps);
    expect(solo.joins).toEqual([]);
    expect(solo.bridgeNodes).toEqual([]);
    expect(solo.classes.map((c) => c.iri)).toEqual([iri('races')]);

    // DIVERGENCE: spec named `results`; the real winning tree routes through `qualifying`.
    const p = extractSubgraph(graph, [iri('laptimes'), iri('constructors')], [], caps);
    const qual = p.classes.find((c) => c.iri === iri('qualifying'))!;
    const cols = qual.properties.map((pr) => pr.col);
    expect(cols).toContain('driverid');
    expect(cols).toContain('constructorid');
    for (const dropped of ['q1', 'q2', 'q3', 'number', 'position']) {
      expect(cols).not.toContain(dropped);
    }
    // Bridge-node columns never carry sample values (context discipline — only terminals do).
    for (const pr of qual.properties) expect(pr.sampleValues).toBeUndefined();
    // A terminal class DOES carry truncated (<=15) enum samples.
    const constructors = p.classes.find((c) => c.iri === iri('constructors'))!;
    for (const pr of constructors.properties) {
      if (pr.sampleValues) expect(pr.sampleValues.length).toBeLessThanOrEqual(15);
    }
  });
});
