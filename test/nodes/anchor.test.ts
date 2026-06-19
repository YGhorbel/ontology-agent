/**
 * Stage 1 acceptance tests — question → AnchorSet (anchoring) over the committed formula1 fixture.
 * No LLM, no network, no DB. Fixture: eval/fixtures/ontologies/formula1-1781704520.jsonld.
 *
 * Anchoring is a STATIC-INDEX lookup (the generator pre-computed sampleValues + SKOS labels),
 * not the field's live-DB LSH. Two matchers unioned (concept + value), recall-favoring: terminals
 * over-return; Stage 2's Steiner + Stage 3a's leash do the final pruning. Test 3 feeds the real
 * `extractSubgraph` to prove the S1→S2 seam end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAnchorIndex } from '../../src/query/anchor-index.js';
import { anchorQuestion } from '../../src/query/anchor.js';
import { buildGraph, loadCapabilities } from '../../src/query/graph-build.js';
import { extractSubgraph } from '../../src/query/subgraph.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const iri = (t: string): string => `qsl:class/${t}`;

const index = buildAnchorIndex(raw);
const CONSTRUCTORS = iri('constructors');
const LAPTIMES = iri('laptimes');
const NATIONALITY = 'qsl:property/constructors/nationality';
const AVG_LAP_TIME = 'qsl:capability/metric/laptimes/average-lap-time-ms';

describe('Stage 1 — anchoring (concept ∪ value, recall-favoring, static-index)', () => {
  it('1. value anchor: "British constructors" → British@constructors.nationality, constructors ∈ terminals', () => {
    const a = anchorQuestion('British constructors', index);
    const v = a.valueAnchors.find((x) => x.value === 'British');
    expect(v).toBeDefined();
    expect(v?.property).toBe(NATIONALITY);
    expect(v?.class).toBe(CONSTRUCTORS);
    expect(v?.matchType).toBe('exact');
    expect(a.terminals).toContain(CONSTRUCTORS);
  });

  it('2. concept/capability anchor: "average lap time" → avg-lap-time capability, laptimes ∈ terminals', () => {
    const a = anchorQuestion('average lap time', index);
    const c = a.conceptAnchors.find((x) => x.iri === AVG_LAP_TIME);
    expect(c).toBeDefined();
    expect(c?.kind).toBe('capability');
    expect(['prefLabel', 'altLabel']).toContain(c?.via);
    expect(a.terminals).toContain(LAPTIMES);
  });

  it('3. multi-terminal union + S1→S2 seam: terminals carry BOTH classes, extractSubgraph connects them', () => {
    const a = anchorQuestion('average lap time for British constructors', index);
    // Union of the two matchers: capability scope (laptimes) AND value class (constructors).
    expect(a.terminals).toContain(LAPTIMES);
    expect(a.terminals).toContain(CONSTRUCTORS);

    // Feed S1 terminals into the REAL Stage-2 extractor — the seam, end to end.
    const graph = buildGraph(raw);
    const caps = loadCapabilities(raw);
    const payload = extractSubgraph(graph, a.terminals, [], caps);
    expect(payload.disconnected).toBeFalsy();
    // Every terminal survives into the connected tree.
    const treeClasses = new Set(payload.classes.map((c) => c.iri));
    expect(treeClasses.has(LAPTIMES)).toBe(true);
    expect(treeClasses.has(CONSTRUCTORS)).toBe(true);
  });

  it('4. fuzzy value match: "Britsh" matches British within threshold; junk does not', () => {
    const a = anchorQuestion('Britsh', index);
    const v = a.valueAnchors.find((x) => x.value === 'British');
    expect(v).toBeDefined();
    expect(v?.matchType).toBe('fuzzy');
    expect(v?.property).toBe(NATIONALITY);
    expect(v!.score).toBeGreaterThanOrEqual(0.82);

    // An unrelated token must not spuriously match any sample value.
    expect(anchorQuestion('wombat', index).valueAnchors).toHaveLength(0);
  });

  it('5. recall-favoring: two plausible class concepts both surface as candidate terminals', () => {
    const a = anchorQuestion('drivers and circuits', index);
    expect(a.terminals).toContain(iri('drivers'));
    expect(a.terminals).toContain(iri('circuits'));
    expect(a.terminals.length).toBeGreaterThanOrEqual(2);
    // The cap is a GENEROUS bound, not a prune-to-one: a generic question keeps both
    // candidates. (Downstream — Steiner + leash — does the final pruning.)
    const withCap = anchorQuestion('drivers and circuits', index, { maxTerminals: 1 });
    expect(withCap.terminals.length).toBe(1); // honoured, but the default is generous (8)
    expect(anchorQuestion('drivers and circuits', index).terminals.length).toBeGreaterThanOrEqual(2);
  });

  it('6. clean index (@graph only) + junk anchors to nothing', () => {
    // No concept/value IRI may trace to the candidate region (built from @graph only).
    const candidateIris = new Set(
      ((raw['qsl:candidateGraph'] as Array<Record<string, unknown>>) ?? []).map((c) => c['@id'] as string),
    );
    expect(candidateIris.size).toBeGreaterThan(0); // fixture really has a candidate graph
    for (const e of index.concepts) expect(candidateIris.has(e.iri)).toBe(false);
    for (const list of index.values.values())
      for (const v of list) expect(candidateIris.has(v.propertyIri)).toBe(false);

    // A junk question anchors to nothing — empty result, no crash.
    const a = anchorQuestion('qwzzx flumph', index);
    expect(a.terminals).toHaveLength(0);
    expect(a.conceptAnchors).toHaveLength(0);
    expect(a.valueAnchors).toHaveLength(0);
  });
});
