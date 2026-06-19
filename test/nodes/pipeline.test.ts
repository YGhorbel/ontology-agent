/**
 * Stage-4 smoke tests — a raw question flowing through all five stages
 * (S1 anchor → S2 subgraph → S3a planner → S3b compiler → execute) as ONE LangGraph
 * flow. These are OBSERVED, not scored: the gate is "it runs end to end and the two
 * failure paths terminate gracefully", NOT answer correctness.
 *
 * Deterministic by construction: the deterministic stages (S1/S2/S3b) run for real over
 * the committed formula1 fixture; S3a's LLM is a deterministic fake (`makeFakeLlm`)
 * returning canned IRs. Execute hits a real DB only when EVAL_FORMULA1_DSN is set
 * (otherwise the SQL-only path is asserted).
 *
 * Cases A/C/E/F use the real fixture. Cases B (single-terminal / no-Steiner) and D
 * (disconnected) use tiny hand-built index+graph: the real recall-favoring S1 cannot
 * deterministically yield a single terminal or a disconnected pair on the well-connected
 * F1 schema, so a minimal synthetic fixture exercises those exact routing paths.
 *
 * Case C is an HONEST SPLIT (see docs/query/pipeline.md): the real S1→S2 proves the
 * CRITICAL-#1 derivation (driverstandings.points + its temporalityEvidence survive the
 * trim) and that the compiler refuses gracefully rather than emitting a naive SUM; a
 * sibling tight-payload assertion proves the snapshot rewrite fires when S2 supplies the
 * calendar edge. The rewrite cannot fire end-to-end through the broad recall-favoring
 * payload because S2's least-cost tree never includes the driverstandings→races edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAnchorIndex, type AnchorIndex } from '../../src/query/anchor-index.js';
import { buildGraph, loadCapabilities } from '../../src/query/graph-build.js';
import { extractSubgraph } from '../../src/query/subgraph.js';
import { compile } from '../../src/query/compiler.js';
import { runPipeline, deriveAnchoredColumns, type PipelineDeps } from '../../src/query/pipeline.js';
import type { OntologyGraph } from '../../src/query/graph-model.js';
import type { AnchorSet } from '../../src/query/anchor-model.js';
import type { MetricQueryIR } from '../../src/query/ir.js';
import { makeFakeLlm } from '../../src/llm/structured-llm.js';
import { classIri, datatypePropertyIri } from '../../src/types/ontology.js';
import { ir1, ir4cumulative } from '../fixtures/ir/index.js';

// ── Real formula1 fixture (built ONCE) ──────────────────────────────────────
const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const index = buildAnchorIndex(raw);
const graph = buildGraph(raw, {});
const graphUniform = buildGraph(raw, { uniform: true });
const capabilities = loadCapabilities(raw);
const realDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({ index, graph, capabilities, ...over });

const ci = (t: string): string => classIri(t);
const fakeIr = (ir: MetricQueryIR) => makeFakeLlm([{ when: () => true, respond: () => ir }]);

// ── A. Happy path, full chain ────────────────────────────────────────────────
describe('Stage-4 pipeline — A. happy path (full chain to SQL)', () => {
  it('flows anchor→subgraph→planner→compiler→(execute) and emits the expected SQL', async () => {
    const dsn = process.env.EVAL_FORMULA1_DSN;
    const deps = realDeps({ llm: fakeIr(ir1) });
    const res = await runPipeline('average lap time for British constructors', deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // S1: recall-favoring terminals include the two we need.
    expect(res.anchorSet.terminals).toEqual(expect.arrayContaining([ci('laptimes'), ci('constructors')]));
    // S2: connected payload.
    expect(res.payload.disconnected).toBeFalsy();
    // S3a: capability measure chosen.
    expect(res.ir.measures[0]?.capability).toBeDefined();
    // S3b: capability expanded + payload group/filter rendered verbatim.
    expect(res.sql).toContain('AVG(laptimes.milliseconds)');
    expect(res.sql).toContain('GROUP BY constructors.nationality');
    expect(res.sql).toContain("WHERE constructors.nationality = 'British'");
    // Every payload join is materialized verbatim in the FROM/JOIN chain.
    for (const j of res.payload.joins) {
      const to = j.to.replace('qsl:class/', '');
      expect(res.sql).toContain(`JOIN ${to} ON `);
    }

    if (dsn) {
      // Real read-only execute (only when a DB is available).
      const { makeReadOnlyDbHandle } = await import('../../eval/src/db.js');
      const db = await makeReadOnlyDbHandle(dsn, 'formula1');
      const res2 = await runPipeline('average lap time for British constructors', realDeps({ llm: fakeIr(ir1), db }));
      expect(res2.ok).toBe(true);
      if (res2.ok) expect(Array.isArray(res2.rows)).toBe(true);
    } else {
      // No DB in CI: SQL-only path — rows absent, but the flow still completes ok.
      expect(res.rows).toBeUndefined();
    }
  });
});

// ── B. Single-table (no-Steiner path) — tiny synthetic fixture ───────────────
describe('Stage-4 pipeline — B. single-table COUNT (no-Steiner path)', () => {
  const thing = ci('thing');
  const bIndex: AnchorIndex = {
    concepts: [{ kind: 'class', iri: thing, scopeClassIri: thing, via: 'prefLabel', surface: 'thing', tokens: ['thing'] }],
    values: new Map(),
  };
  const bGraph: OntologyGraph = {
    nodes: new Map([[thing, { iri: thing, table: 'thing', properties: [{ col: 'name', sampleValues: ['a', 'b', 'c'] }] }]]),
    adjacency: new Map([[thing, []]]),
  };
  const countIr: MetricQueryIR = { measures: [{ aggExpr: { fn: 'COUNT', property: datatypePropertyIri('thing', 'name') }, alias: 'n' }] };

  it('routes a single terminal through a trivial (joinless) payload to COUNT SQL', async () => {
    const res = await runPipeline('thing', { index: bIndex, graph: bGraph, capabilities: [], llm: fakeIr(countIr) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchorSet.terminals).toEqual([thing]); // length 1
    expect(res.payload.joins).toHaveLength(0); // S2 trivial
    expect(res.payload.totalCost).toBe(0);
    expect(res.sql).toContain('COUNT(thing.name)');
    expect(res.sql).toContain('FROM thing');
    expect(res.sql).not.toContain('JOIN');
  });
});

// ── C. H2 column survives the trim (CRITICAL #1 proof) — honest split ─────────
describe('Stage-4 pipeline — C. H2 cumulative column survives anchoring→trim (CRITICAL #1)', () => {
  it('end-to-end: derivation keeps driverstandings.points + evidence, compiler refuses gracefully (no naive SUM)', async () => {
    const res = await runPipeline('total championship points by season', realDeps({ llm: fakeIr(ir4cumulative) }));

    // The derivation surfaced the cumulative measure column.
    expect(res.anchorSet).toBeDefined();
    const anchored = deriveAnchoredColumns(res.anchorSet!);
    expect(anchored.get(ci('driverstandings'))).toContain('points');

    // It survived the trim WITH its temporalityEvidence (the H2-load-bearing payload state).
    const ds = res.payload!.classes.find((c) => c.iri === ci('driverstandings'))!;
    const points = ds.properties.find((p) => p.col === 'points')!;
    expect(points.temporality).toBe('cumulative-snapshot');
    expect(points.temporalityEvidence?.partitionColumns).toEqual(['driverid', 'year']);

    // Because the evidence survived, the compiler KNOWS it is cumulative and refuses to emit a
    // naive SUM — it fails gracefully (S2's broad tree lacks the driverstandings→races edge the
    // fold needs). This is the graceful terminal state, NOT a wrong silent aggregate.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.stage).toBe('compiler');
    expect(res.failure.reason).toBe('temporality-unreachable');
  });

  it('the SAME derivation feeds the compiler to the snapshot rewrite when S2 supplies the calendar edge', () => {
    // The driverstandings→races edge is a DISCOVERED FK (conf 0.95): under confidence-weighting
    // the declared driverid→drivers edge wins, so the calendar edge is selected only in uniform
    // mode. The fold also needs the grain columns (driverstandings.driverid local partition +
    // races.year/round) retained — so they must be anchored. A real recall-favoring question
    // anchors none of driverid/round, which is exactly why the rewrite can't fire end-to-end.
    const propAnchor = (t: string, c: string) =>
      ({ kind: 'property' as const, iri: datatypePropertyIri(t, c), matchedText: c, via: 'prefLabel' as const, score: 1 });
    const set: AnchorSet = {
      terminals: [ci('driverstandings'), ci('races')],
      conceptAnchors: [
        propAnchor('driverstandings', 'points'),
        propAnchor('driverstandings', 'driverid'),
        propAnchor('races', 'year'),
        propAnchor('races', 'round'),
      ],
      valueAnchors: [],
      trace: { keywords: [], conceptCandidates: [], valueCandidates: [], union: [], terminals: [] },
    };
    const anchoredColumns = deriveAnchoredColumns(set);
    expect(anchoredColumns.get(ci('driverstandings'))).toEqual(expect.arrayContaining(['points', 'driverid']));
    expect(anchoredColumns.get(ci('races'))).toEqual(expect.arrayContaining(['year', 'round']));
    const payload = extractSubgraph(graphUniform, set.terminals, [], capabilities, { anchoredColumns });

    // Same compiler the pipeline's compileNode uses — assert the snapshot rewrite fires.
    const { sql } = compile(ir4cumulative, payload);
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY driverstandings.driverid, races.year ORDER BY races.round DESC)');
    expect(sql).toContain('__qsl_snap_rn = 1');
  });
});

// ── D. Disconnected → graceful failure — tiny synthetic fixture ──────────────
describe('Stage-4 pipeline — D. disconnected terminals → graceful failure', () => {
  const a = ci('a');
  const b = ci('b');
  const dIndex: AnchorIndex = {
    concepts: [
      { kind: 'class', iri: a, scopeClassIri: a, via: 'prefLabel', surface: 'alpha', tokens: ['alpha'] },
      { kind: 'class', iri: b, scopeClassIri: b, via: 'prefLabel', surface: 'beta', tokens: ['beta'] },
    ],
    values: new Map(),
  };
  const dGraph: OntologyGraph = {
    nodes: new Map([
      [a, { iri: a, table: 'a', properties: [{ col: 'id' }] }],
      [b, { iri: b, table: 'b', properties: [{ col: 'id' }] }],
    ]),
    adjacency: new Map([[a, []], [b, []]]),
  };

  it('routes a disconnected subgraph to failure.stage=subgraph without throwing', async () => {
    const res = await runPipeline('alpha beta', { index: dIndex, graph: dGraph, capabilities: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.stage).toBe('subgraph');
    expect(res.failure.reason).toBe('disconnected');
    expect(res.traces.subgraph?.disconnected).toBe(true);
  });
});

// ── E. PlannerFailure → graceful failure ─────────────────────────────────────
describe('Stage-4 pipeline — E. planner repair-exhausted → graceful failure', () => {
  it('routes a leash-invalid IR to failure.stage=planner without throwing', async () => {
    // Fake LLM always returns an IR referencing a property NOT in the payload → leash fails.
    const invalid: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'COUNT', property: datatypePropertyIri('does_not_exist', 'nope') }, alias: 'n' }],
    };
    const res = await runPipeline(
      'average lap time for British constructors',
      realDeps({ llm: fakeIr(invalid), plannerOpts: { maxRetries: 0 } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.stage).toBe('planner');
    expect(res.failure.reason).toBe('repair-exhausted');
    expect(res.traces.planner).toBeDefined();
  });
});

// ── F. Trace completeness (the provenance spine) ─────────────────────────────
describe('Stage-4 pipeline — F. traces assemble the provenance spine', () => {
  it('carries anchor/subgraph/planner/compiler slices on the happy path', async () => {
    const res = await runPipeline('average lap time for British constructors', realDeps({ llm: fakeIr(ir1) }));
    expect(res.traces.anchor).toBeDefined();
    expect(res.traces.subgraph).toBeDefined();
    expect(res.traces.planner).toBeDefined();
    expect(res.traces.compiler).toBeDefined();
  });
});
