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
import { pruneTerminals } from '../../src/query/prune.js';
import { groundSuperlatives } from '../../src/query/superlative.js';
import type { OntologyGraph } from '../../src/query/graph-model.js';

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

/**
 * Stage-1.x — superlative grounding (date-only, single-candidate self-scoping rule).
 * A superlative binds to the SOLE orderable column of its dimension type on a candidate class, so
 * pruning + the S2 trimmer keep it; ambiguous (0 or >1 candidate) → fall through. No LLM/DB.
 */
describe('Stage 1.x — superlative grounding (single-candidate, date-only)', () => {
  const fxGraph = buildGraph(raw);
  const caps = loadCapabilities(raw);
  const DRIVERS = iri('drivers');
  const candidates = (q: string): string[] => pruneTerminals(anchorQuestion(q, index)).terminals;
  // Synthetic graph helper for the ambiguous / id-exclusion cases (the F1 fixture has no class
  // with two date columns — a real date superlative over `races` correctly grounds its sole date).
  const synth = (table: string, properties: { col: string; dataType?: string; isPrimaryKey?: boolean }[]): OntologyGraph => ({
    nodes: new Map([[iri(table), { iri: iri(table), table, properties }]]),
    adjacency: new Map([[iri(table), []]]),
  });

  it('1. single date superlative grounds drivers.dob (ASC), and it survives the trim', () => {
    const oldest = groundSuperlatives('who is the oldest driver', candidates('who is the oldest driver'), fxGraph);
    const d = oldest.find((x) => x.classIri === DRIVERS);
    expect(d).toBeDefined();
    expect(d?.column).toBe('dob');
    expect(d?.dir).toBe('ASC'); // min date = oldest
    expect(d?.provenance).toBe('superlative');

    // "youngest" grounds the same column, opposite direction.
    const young = groundSuperlatives('the youngest driver', candidates('the youngest driver'), fxGraph);
    expect(young.find((x) => x.classIri === DRIVERS)?.dir).toBe('DESC');

    // Survival: before this brick dob (no enum samples) was trimmed; grounded-as-anchored, it survives.
    const terminals = candidates('who is the oldest driver');
    const baseline = extractSubgraph(fxGraph, terminals, [], caps, {});
    const baseDrivers = baseline.classes.find((c) => c.iri === DRIVERS);
    expect(baseDrivers?.properties.some((p) => p.col === 'dob')).toBe(false); // dropped without grounding

    const anchoredColumns = new Map<string, string[]>([[DRIVERS, ['dob']]]);
    const grounded = extractSubgraph(fxGraph, terminals, [], caps, { anchoredColumns });
    const gDrivers = grounded.classes.find((c) => c.iri === DRIVERS);
    expect(gDrivers?.properties.some((p) => p.col === 'dob')).toBe(true); // survives once anchored
  });

  it('2. id/type exclusion: grounds dob, never driverid (the original wrong-column bug)', () => {
    const g = groundSuperlatives('who is the oldest driver', candidates('who is the oldest driver'), fxGraph);
    const driversCols = g.filter((x) => x.classIri === DRIVERS).map((x) => x.column);
    expect(driversCols).toEqual(['dob']); // dob is the SOLE date orderable in drivers
    expect(driversCols).not.toContain('driverid'); // bigint + PK + ends-in-'id' → excluded
  });

  it('3. multi-candidate falls through (AmbiSQL guard); id-exclusion brings the count back to one', () => {
    // Two plain date columns compete → ambiguous → NO grounding (never guess).
    const twoDate = synth('events', [
      { col: 'created_at', dataType: 'date' },
      { col: 'updated_at', dataType: 'date' },
      { col: 'name', dataType: 'text' },
    ]);
    expect(groundSuperlatives('the oldest event', [iri('events')], twoDate)).toEqual([]);

    // One plain date + one date-typed PK/id column → the id is excluded, count → 1 → grounds the plain one.
    const idPlusDate = synth('events', [
      { col: 'event_id', dataType: 'date', isPrimaryKey: true },
      { col: 'recorded_at', dataType: 'date' },
    ]);
    const g = groundSuperlatives('the latest event', [iri('events')], idPlusDate);
    expect(g).toHaveLength(1);
    expect(g[0]?.column).toBe('recorded_at');
    expect(g[0]?.dir).toBe('DESC');
  });

  it('4. zero-candidate falls through: a date superlative over a class with no date column', () => {
    // constructors has no date column (id/text/numeric only) → no grounding, no crash.
    expect(groundSuperlatives('the oldest constructor', [iri('constructors')], fxGraph)).toEqual([]);
    // Likewise a synthetic class with no date column.
    const noDate = synth('widgets', [{ col: 'widget_id', dataType: 'bigint', isPrimaryKey: true }, { col: 'label', dataType: 'text' }]);
    expect(groundSuperlatives('the newest widget', [iri('widgets')], noDate)).toEqual([]);
  });

  it('5. non-regression: a question with no superlative token grounds nothing', () => {
    expect(groundSuperlatives('average lap time for British constructors', candidates('average lap time for British constructors'), fxGraph)).toEqual([]);
    expect(groundSuperlatives('reference names of all the drivers who were eliminated in the first period in race number 20', candidates('drivers eliminated in qualifying for race 20'), fxGraph)).toEqual([]);
  });
});
