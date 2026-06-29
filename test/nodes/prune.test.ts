/**
 * Stage-1.5 semantic pruning — drop recall-favoring terminals the question doesn't
 * SPECIFICALLY ground, before Steiner routes. Deterministic: real `anchorQuestion`
 * over the committed formula1 fixture, then the pure `pruneTerminals`. No LLM, no DB.
 *
 * The headline (Case 1) is the brick's whole point: the canonical "drivers eliminated
 * in the first period in race 20" over-join shrinks because the generic-column noise
 * terminals are pruned out of the must-include set BEFORE the cheapest-tree routing.
 *
 * See docs/query/pruning.md and docs/adr/008-semantic-pruning.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAnchorIndex } from '../../src/query/anchor-index.js';
import { buildGraph, loadCapabilities } from '../../src/query/graph-build.js';
import { extractSubgraph } from '../../src/query/subgraph.js';
import { anchorQuestion } from '../../src/query/anchor.js';
import { pruneTerminals } from '../../src/query/prune.js';
import { groundSuperlatives } from '../../src/query/superlative.js';
import { classIri } from '../../src/types/ontology.js';
import type { AnchorSet } from '../../src/query/anchor-model.js';

// ── Real formula1 fixture (built ONCE) ──────────────────────────────────────
const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const index = buildAnchorIndex(raw);
const graph = buildGraph(raw, {});
const capabilities = loadCapabilities(raw);

const ci = (t: string): string => classIri(t);
const CANONICAL = 'reference names of all the drivers who were eliminated in the first period in race number 20';

// ── 1. Canonical over-join shrinks ───────────────────────────────────────────
describe('prune — 1. the canonical over-join shrinks', () => {
  it('keeps the grounded terminals, drops the generic-column noise, and routes fewer joins', () => {
    const set = anchorQuestion(CANONICAL, index);
    const { terminals: kept } = pruneTerminals(set);

    // Grounded ones survive: drivers/races (named the table), qualifying ("first"→q1, df=1).
    expect(kept).toEqual(expect.arrayContaining([ci('drivers'), ci('races'), ci('qualifying')]));
    // Generic-column noise is dropped (each was grounded ONLY by shared columns / FKs).
    for (const noise of ['constructors', 'circuits', 'pitstops', 'constructorresults']) {
      expect(kept).not.toContain(ci(noise));
    }

    // The over-join shrinks: pruned terminal set → strictly fewer joins than the raw set.
    const before = extractSubgraph(graph, set.terminals, [], capabilities, {});
    const after = extractSubgraph(graph, kept, [], capabilities, {});
    expect(after.joins.length).toBeLessThan(before.joins.length);
    expect(after.disconnected).toBeFalsy();
  });
});

// ── 2. A value-anchored terminal is always kept ──────────────────────────────
describe('prune — 2. value-anchored terminals are never pruned', () => {
  it('keeps constructors when a value anchor ("British") grounds it', () => {
    const set = anchorQuestion('British constructors', index);
    const { terminals: kept, trace } = pruneTerminals(set);
    expect(set.valueAnchors.some((v) => v.class === ci('constructors'))).toBe(true);
    expect(kept).toContain(ci('constructors'));
    expect(trace.groundedBy[ci('constructors')]).toBeDefined();
  });
});

// ── 3. Bridge nodes still allowed (recall safety) ────────────────────────────
describe('prune — 3. pruning never breaks Steiner connectivity (bridges added freely)', () => {
  it('keeps laptimes + constructors (both grounded) and still routes a connected tree via bridges', () => {
    const set = anchorQuestion('average lap time for British constructors', index);
    const { terminals: kept } = pruneTerminals(set);
    expect(kept).toEqual(expect.arrayContaining([ci('laptimes'), ci('constructors')]));

    // Pruning removed terminals from the must-include set, not connectivity: the kept set still
    // routes a connected tree, and any bridge Steiner adds is an unanchored (non-kept) class.
    const payload = extractSubgraph(graph, kept, [], capabilities, {});
    expect(payload.disconnected).toBeFalsy();
    for (const b of payload.bridgeNodes) expect(kept).not.toContain(b);

    // And Steiner STILL adds unanchored bridges when a terminal pair genuinely needs them:
    // {laptimes, constructors} connect only through drivers/qualifying — neither a terminal.
    const bridged = extractSubgraph(graph, [ci('laptimes'), ci('constructors')], [], capabilities, {});
    expect(bridged.disconnected).toBeFalsy();
    expect(bridged.bridgeNodes.length).toBeGreaterThan(0);
    expect(bridged.bridgeNodes).not.toContain(ci('laptimes'));
    expect(bridged.bridgeNodes).not.toContain(ci('constructors'));
  });
});

// ── 4. Single / zero terminal after prune ────────────────────────────────────
describe('prune — 4. single and empty results are safe', () => {
  it('keeps the lone grounded terminal of a single-class question (trivial subgraph)', () => {
    // A class anchor with no other grounded terminals.
    const single: AnchorSet = {
      terminals: [ci('drivers')],
      conceptAnchors: [
        { kind: 'class', iri: ci('drivers'), scopeClassIri: ci('drivers'), matchedText: 'driver', via: 'prefLabel', score: 1 },
      ],
      valueAnchors: [],
      trace: { keywords: [], conceptCandidates: [], valueCandidates: [], union: [], terminals: [] },
    };
    const { terminals: kept } = pruneTerminals(single);
    expect(kept).toEqual([ci('drivers')]);
    const payload = extractSubgraph(graph, kept, [], capabilities, {});
    expect(payload.joins).toHaveLength(0); // trivial single-node subgraph
  });

  it('falls back to the best-grounded terminal rather than returning an empty set', () => {
    // Three terminals all sharing one generic keyword "race" (df=3 > default floor 2) → no
    // clause fires for any of them, so the empty-set fallback keeps the single best-scored one.
    const generic: AnchorSet = {
      terminals: [ci('pitstops'), ci('results'), ci('laptimes')],
      conceptAnchors: [
        { kind: 'property', iri: 'qsl:property/pitstops/raceid', scopeClassIri: ci('pitstops'), matchedText: 'race', via: 'prefLabel', score: 0.9 },
        { kind: 'property', iri: 'qsl:property/results/raceid', scopeClassIri: ci('results'), matchedText: 'race', via: 'prefLabel', score: 0.95 },
        { kind: 'property', iri: 'qsl:property/laptimes/raceid', scopeClassIri: ci('laptimes'), matchedText: 'race', via: 'prefLabel', score: 0.85 },
      ],
      valueAnchors: [],
      trace: { keywords: [], conceptCandidates: [], valueCandidates: [], union: [], terminals: [] },
    };
    const { terminals: kept, trace } = pruneTerminals(generic);
    expect(kept).toHaveLength(1); // never empty
    expect(kept[0]).toBe(ci('results')); // the higher-scored grounding wins the fallback
    expect(trace.dropped.map((d) => d.iri)).not.toContain(ci('results'));
  });
});

// ── 5. Trace provenance (the certificate spine) ──────────────────────────────
describe('prune — 5. PruneTrace records why each terminal was kept or dropped', () => {
  it('labels kept terminals by grounding kind and dropped terminals with a reason', () => {
    const set = anchorQuestion(CANONICAL, index);
    const { trace } = pruneTerminals(set);

    expect(trace.candidates).toEqual(set.terminals);
    // Every kept terminal carries a grounding label.
    for (const k of trace.kept) expect(trace.groundedBy[k]).toBeDefined();
    expect(trace.groundedBy[ci('drivers')]).toBe('class'); // named the table
    // Every dropped terminal carries a reason; the noise ones are present.
    const droppedIris = trace.dropped.map((d) => d.iri);
    expect(droppedIris).toContain(ci('constructors'));
    for (const d of trace.dropped) expect(d.reason).toMatch(/generic|no exact-class/);
  });
});

// ── 6. Superlative grounding is orthogonal to prune (it touches trim, not the terminal set) ──
describe('prune — 6. superlative grounding does not change the pruned terminal set', () => {
  it('a date superlative leaves the pruned terminals identical (grounding adds a column, not a terminal)', () => {
    const set = anchorQuestion('who is the oldest driver', index);
    const before = pruneTerminals(set).terminals;
    // Grounding runs over the pruned terminals; it must not mutate the AnchorSet or the prune outcome.
    groundSuperlatives('who is the oldest driver', before, graph);
    const after = pruneTerminals(set).terminals;
    expect(after).toEqual(before);
    expect(after).toContain(ci('drivers'));
  });
});
