/**
 * Stage 1.6 — FK-symmetric grain-competitor sibling survival (ADR-014).
 *
 * Deterministic: real `anchorQuestion` + `pruneTerminals` over the committed formula1 fixture, then the
 * pure `rescueFkSymmetricSiblings`. No LLM, no DB. The headline is the diagnostic's dominant grain
 * failure (TABLE-DROP:S2): the prune drops the correct fact table because an FK-symmetric sibling
 * survives by grain-blind specificity; 950 and 994 are mirror images. The brick keeps BOTH so Move 1's
 * grain tag can choose (the BOTH-PRESENT state), and composes with back-prune (the unreferenced sibling
 * is a degree-1 leaf, droppable).
 *
 * See docs/diagnosis/grain-retrieval-survival.md, docs/adr/014-sibling-survival.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAnchorIndex } from '../../src/query/anchor-index.js';
import { buildGraph, loadCapabilities } from '../../src/query/graph-build.js';
import { anchorQuestion } from '../../src/query/anchor.js';
import { pruneTerminals } from '../../src/query/prune.js';
import { deriveAnchoredColumns } from '../../src/query/pipeline.js';
import { rescueFkSymmetricSiblings } from '../../src/query/sibling-survival.js';
import { extractSubgraph } from '../../src/query/subgraph.js';
import { renderPayloadMenu } from '../../src/prompts/planner.js';
import { compile } from '../../src/query/compiler.js';
import { classIri } from '../../src/types/ontology.js';
import { payloadFor, prop, classIriOf } from '../fixtures/ir/index.js';
import type { MetricQueryIR } from '../../src/query/ir.js';
import type { OntologyGraph } from '../../src/query/graph-model.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const index = buildAnchorIndex(raw);
const graph: OntologyGraph = buildGraph(raw, {});
const caps = loadCapabilities(raw);

const tbl = (iri: string): string => iri.split('/').pop() ?? iri;
const ci = (t: string): string => classIri(t);

/** Run S1 → prune → rescue for a question (the production seam, sans LLM/DB). */
function runRescue(q: string) {
  const set = anchorQuestion(q, index);
  const { terminals: kept } = pruneTerminals(set);
  const anchoredColumns = deriveAnchoredColumns(set);
  const res = rescueFkSymmetricSiblings({ candidates: set.terminals, kept, anchoredColumns, graph });
  return { set, kept, anchoredColumns, res };
}

const Q950 = 'Please list the constructor names with 0 points at race 291.';
const Q994 =
  'Which constructor scored most points from Monaco Grand Prix between 1980 and 2010? List the score, name and nationality of this team.';

// ── 1. Trigger fires + reproduces the diagnostic's mirror-image picture (950 / 994) ──
describe('sibling-survival — 1. the trigger fires on the FK-symmetric points pair', () => {
  it('950: prune keeps constructorresults, drops constructorstandings; rescue re-admits the gold', () => {
    const { kept, res } = runRescue(Q950);
    // Reproduces the diagnostic's terminal picture (stands in for the missing grain-trace.ts).
    expect(kept.map(tbl)).toContain('constructorresults');
    expect(kept.map(tbl)).not.toContain('constructorstandings');
    // Rescue re-admits the dropped grain sibling (the gold table).
    expect(res.trace.rescued.map(tbl)).toEqual(['constructorstandings']);
    expect(res.terminals.map(tbl)).toEqual(expect.arrayContaining(['constructorresults', 'constructorstandings']));
    // The certificate names the shared grain column and the declared signature.
    const grp = res.trace.groups.find((g) => g.members.map(tbl).includes('constructorstandings'));
    expect(grp?.members.map(tbl).sort()).toEqual(['constructorresults', 'constructorstandings']);
    expect(grp?.sharedColumns).toEqual(['points']);
    expect(grp?.signature.map(tbl)).toEqual(['constructors']);
  });

  it('994: the mirror image — prune keeps constructorstandings, drops constructorresults; rescue re-admits it', () => {
    const { kept, res } = runRescue(Q994);
    expect(kept.map(tbl)).toContain('constructorstandings');
    expect(kept.map(tbl)).not.toContain('constructorresults');
    expect(res.trace.rescued.map(tbl)).toEqual(['constructorresults']);
    expect(res.terminals.map(tbl)).toEqual(expect.arrayContaining(['constructorresults', 'constructorstandings']));
  });
});

// ── 2. Trigger does NOT fire: not FK-symmetric, or no shared non-key anchored column ──
describe('sibling-survival — 2. the trigger stays narrow (no spurious widening)', () => {
  it('does NOT fire when the shared anchored column is a join key (constructorid), not a measure', () => {
    // Both siblings carry `constructorid` (a join key) — that must NOT trigger keep-both.
    const candidates = [ci('constructorresults'), ci('constructorstandings'), ci('constructors')];
    const anchoredColumns = new Map<string, string[]>([
      [ci('constructorresults'), ['constructorid']],
      [ci('constructorstandings'), ['constructorid']],
    ]);
    const res = rescueFkSymmetricSiblings({
      candidates,
      kept: [ci('constructorresults')],
      anchoredColumns,
      graph,
    });
    expect(res.trace.groups).toHaveLength(0);
    expect(res.terminals).toEqual([ci('constructorresults')]);
  });

  it('does NOT fire when neighbour signatures differ (constructorstandings {constructors} vs driverstandings {drivers})', () => {
    // Both carry an anchored `points` measure, but they are not FK-symmetric.
    const candidates = [ci('constructorstandings'), ci('driverstandings')];
    const anchoredColumns = new Map<string, string[]>([
      [ci('constructorstandings'), ['points']],
      [ci('driverstandings'), ['points']],
    ]);
    const res = rescueFkSymmetricSiblings({
      candidates,
      kept: [ci('constructorstandings')],
      anchoredColumns,
      graph,
    });
    expect(res.trace.groups).toHaveLength(0);
    expect(res.terminals).toEqual([ci('constructorstandings')]);
  });
});

// ── 3. Narrowing gate: never re-introduce a group the prune fully rejected ──
describe('sibling-survival — 3. the narrowing gate (≥1 member must have survived the prune)', () => {
  it('does NOT rescue an FK-symmetric grain pair when NEITHER sibling was kept', () => {
    const candidates = [ci('constructorresults'), ci('constructorstandings')];
    const anchoredColumns = new Map<string, string[]>([
      [ci('constructorresults'), ['points']],
      [ci('constructorstandings'), ['points']],
    ]);
    const res = rescueFkSymmetricSiblings({ candidates, kept: [], anchoredColumns, graph });
    expect(res.trace.groups).toHaveLength(0);
    expect(res.terminals).toEqual([]);
  });

  it('rescues the dropped sibling when exactly one survived', () => {
    const candidates = [ci('constructorresults'), ci('constructorstandings')];
    const anchoredColumns = new Map<string, string[]>([
      [ci('constructorresults'), ['points']],
      [ci('constructorstandings'), ['points']],
    ]);
    const res = rescueFkSymmetricSiblings({
      candidates,
      kept: [ci('constructorresults')],
      anchoredColumns,
      graph,
    });
    expect(res.trace.rescued).toEqual([ci('constructorstandings')]);
  });
});

// ── 4. Menu co-occurrence (composes with Move 1 / ADR-013) ──
describe('sibling-survival — 4. both siblings reach the menu, the cumulative one grain-tagged', () => {
  it('renders constructorstandings.points [cumulative snapshot] AND constructorresults.points together', () => {
    // The BOTH-PRESENT payload the rescue produces (both terminals, both `points` anchored).
    const payload = payloadFor(['constructorstandings', 'constructorresults'], {
      anchored: { constructorstandings: ['points'], constructorresults: ['points'] },
    });
    const menu = renderPayloadMenu(payload);
    expect(menu).toContain('constructorstandings/points');
    expect(menu).toContain('constructorresults/points');
    // Move 1's grain tag fires on the cumulative sibling (rendered generically from qsl:temporality).
    const csLine = menu.split('\n').find((l) => l.includes('constructorstandings/points'));
    expect(csLine).toMatch(/\[cumulative snapshot\]/);
  });
});

// ── 5. Back-prune composition: the unreferenced sibling is dropped from FROM (ADR-012) ──
describe('sibling-survival — 5. composes with back-prune (no over-join re-introduced)', () => {
  const bothPayload = () =>
    payloadFor(['constructorstandings', 'constructorresults'], {
      anchored: { constructorstandings: ['points'], constructorresults: ['points'], constructors: ['name'] },
    });

  it('an IR referencing only constructorstandings drops constructorresults from the compiled FROM', () => {
    const payload = bothPayload();
    const ir: MetricQueryIR = {
      select: [{ property: prop('constructors', 'name') }],
      filters: [{ property: prop('constructorstandings', 'points'), op: '=', value: 0 }],
    };
    const { sql } = compile(ir, payload);
    expect(sql).toContain('constructorstandings');
    expect(sql).not.toMatch(/\bconstructorresults\b/); // unreferenced sibling pruned from FROM
  });

  it('the unreferenced sibling is a degree-1 leaf in the both-siblings payload (articulation safety)', () => {
    const payload = bothPayload();
    const degree = new Map<string, number>();
    for (const j of payload.joins) {
      degree.set(j.from, (degree.get(j.from) ?? 0) + 1);
      degree.set(j.to, (degree.get(j.to) ?? 0) + 1);
    }
    for (const sib of ['constructorresults', 'constructorstandings']) {
      const iri = payload.classes.find((c) => tbl(c.iri) === sib)?.iri;
      expect(iri, `${sib} present in payload`).toBeDefined();
      expect(degree.get(iri!) ?? 0, `${sib} is a droppable leaf`).toBeLessThanOrEqual(1);
    }
  });
});

// ── 6. Non-regression: a question that never triggers is byte-identical to today ──
describe('sibling-survival — 6. no-op when the trigger never fires', () => {
  it('the canonical over-join question rescues nothing (terminals == prune kept)', () => {
    const { kept, res } = runRescue(
      'reference names of all the drivers who were eliminated in the first period in race number 20',
    );
    expect(res.trace.groups).toHaveLength(0);
    expect(res.trace.rescued).toEqual([]);
    expect(res.terminals).toEqual(kept);
  });

  it('extract over the rescued set equals extract over the pruned set when no rescue happened', () => {
    const q = 'reference names of all the drivers who were eliminated in the first period in race number 20';
    const { kept, anchoredColumns, res } = runRescue(q);
    const a = extractSubgraph(graph, kept, [], caps, { anchoredColumns });
    const b = extractSubgraph(graph, res.terminals, [], caps, { anchoredColumns });
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });
});
