/**
 * Stage 1.5 (semantic pruning) — the missing middle stage between grounding (S1
 * anchoring) and reasoning (S2 Steiner routing).
 *
 * PipeNet ("Question Answering with Semantic Pruning over Knowledge Graphs", Su et al.)
 * inserts a PRUNING stage between grounding and the graph step that drops nodes the
 * question doesn't really point at, BEFORE the expensive routing. We adopt that
 * placement, but our relatedness signal is ANCHOR PROVENANCE over the profiled ontology
 * — not PipeNet's dependency-parse distance over a hand-built KG. READS (Xu et al.)
 * adds the discriminative principle: constrain to GROUNDED options, never free generation.
 *
 * Why this stage exists: S1 is deliberately RECALL-FAVORING — it over-returns candidate
 * `terminals` so it never misses. But intact F1 is fully connected at low Steiner cost,
 * so S2 happily weaves EVERY recall-favoring terminal into one big tree. Pruning is the
 * reconciling step: keep S1 recall-favoring, then drop the terminals the question only
 * brushed (generic shared columns) before they distort the cheapest-tree routing.
 *
 * THE CORRECTNESS ARGUMENT — must-include set, NOT may-traverse set:
 * We prune the TERMINAL SET (the classes Steiner must span), never the OntologyGraph
 * Steiner traverses. Steiner stays free to route through unanchored BRIDGE classes
 * (e.g. drivers/results bridging laptimes↔constructors). This mirrors PipeNet keeping
 * V_q ∪ V_a and pruning only the external/expansion set V_e — pruning the must-include
 * set can never break connectivity, because bridges are added at routing time.
 *
 * THE RULE (calibrated against the real F1 index — see docs/query/pruning.md): a naive
 * "directness + score floor" rule is provably insufficient here. Every recall-favoring
 * terminal is grounded by a DIRECT, score-1.0 anchor (constructorref↔"reference",
 * circuits.name↔"name", pitstops.driverid↔"driver"), while the one terminal we must keep
 * — qualifying — has its only meaningful grounding at q1↔"first" 0.803, BELOW the noise.
 * Score is inverted; the discriminating signal is SPECIFICITY. A terminal is kept iff:
 *   1. an EXACT class anchor lands on it (the table name itself appears), OR
 *   2. a value anchor classes to it (a data value was named), OR
 *   3. a SPECIFIC keyword grounds it — one whose document-frequency across the whole
 *      AnchorSet is ≤ KEYWORD_DF (it points at this class AND no other).
 * This is an IDF-style discriminative term over anchor provenance — no hardcoded table
 * names, fully question-relative.
 *
 * Pure, deterministic function over the AnchorSet: no graph, no LLM, no DB.
 *
 * See docs/query/pruning.md and docs/adr/008-semantic-pruning.md.
 */
import type { AnchorSet, ConceptAnchor } from './anchor-model.js';

/** Why a terminal was kept (the strongest grounding clause that fired) or dropped. */
export type GroundedBy = 'class' | 'property' | 'capability' | 'value';

/** Full provenance for the certificate + debugging. */
export interface PruneTrace {
  /** The recall-favoring candidate terminals handed in (mirrors `AnchorSet.terminals`). */
  candidates: string[];
  /** The kept terminals passed on to Stage 2. */
  kept: string[];
  /** Dropped terminals with a human-readable reason. */
  dropped: { iri: string; reason: string }[];
  /** For each KEPT terminal, which anchor kind grounded it. */
  groundedBy: Record<string, GroundedBy>;
}

export interface PruneResult {
  terminals: string[];
  trace: PruneTrace;
}

export interface PruneOpts {
  /** Max document-frequency for a keyword to count as "specific". Default `QUERY_PRUNE_KEYWORD_DF` or 2. */
  keywordDf?: number;
  /** Min score for a `class` anchor to count as "exact" (names the table). Default 1.0. */
  classExact?: number;
}

/** Read a numeric env knob, mirroring graph-build.ts's `num()` convention. */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** A concept anchor genuinely usable as grounding evidence (prose-only hits don't count). */
function isGroundingConcept(c: ConceptAnchor): boolean {
  return c.via !== 'description';
}

/**
 * Prune the recall-favoring terminal set down to the ones the question SPECIFICALLY
 * grounds, leaving generic-shared-column noise behind. Removes from the must-include
 * set only — Steiner still routes through unanchored bridges freely.
 */
export function pruneTerminals(anchorSet: AnchorSet, opts: PruneOpts = {}): PruneResult {
  // Default 2, not 1: profiled ontologies have PARALLEL entity pairs (driver/constructor),
  // so a genuinely specific concept ("championship points") legitimately maps to ~2 classes.
  // df ≤ 1 would over-prune the needed table; df ≤ 2 tolerates exactly one parallel sibling.
  const keywordDf = opts.keywordDf ?? numEnv('QUERY_PRUNE_KEYWORD_DF', 2);
  const classExact = opts.classExact ?? 1;

  const candidates = anchorSet.terminals;

  // --- Document-frequency of each matched keyword across the whole AnchorSet. ---
  // df(keyword) = number of DISTINCT scope classes that keyword grounds. A keyword that
  // grounds exactly one class "points at" that class and no other → specific.
  const dfClasses = new Map<string, Set<string>>();
  const note = (keyword: string, cls: string): void => {
    const s = dfClasses.get(keyword) ?? new Set<string>();
    s.add(cls);
    dfClasses.set(keyword, s);
  };
  for (const c of anchorSet.conceptAnchors) {
    if (!isGroundingConcept(c)) continue;
    note(c.matchedText, c.scopeClassIri);
  }
  for (const v of anchorSet.valueAnchors) note(v.matchedKeyword, v.class);
  const df = (keyword: string): number => dfClasses.get(keyword)?.size ?? 0;

  // --- Per-terminal grounding evidence. ---
  const kept: string[] = [];
  const dropped: { iri: string; reason: string }[] = [];
  const groundedBy: Record<string, GroundedBy> = {};

  // Best single grounding score per terminal — only used for the empty-set fallback.
  const bestScore = new Map<string, number>();
  const bumpBest = (cls: string, score: number): void => {
    const prev = bestScore.get(cls);
    if (prev === undefined || score > prev) bestScore.set(cls, score);
  };
  for (const c of anchorSet.conceptAnchors) if (isGroundingConcept(c)) bumpBest(c.scopeClassIri, c.score);
  for (const v of anchorSet.valueAnchors) bumpBest(v.class, v.score);

  for (const t of candidates) {
    // Clause 1 — exact class anchor (the question named the table itself).
    const exactClass = anchorSet.conceptAnchors.some(
      (c) => c.kind === 'class' && c.scopeClassIri === t && c.score >= classExact,
    );
    if (exactClass) {
      kept.push(t);
      groundedBy[t] = 'class';
      continue;
    }
    // Clause 2 — a value anchor classed to this terminal (the question named a data value).
    const valueAnchor = anchorSet.valueAnchors.find((v) => v.class === t);
    if (valueAnchor) {
      kept.push(t);
      groundedBy[t] = 'value';
      continue;
    }
    // Clause 3 — a SPECIFIC keyword (df ≤ keywordDf) grounds this terminal.
    const specificConcept = anchorSet.conceptAnchors.find(
      (c) => isGroundingConcept(c) && c.scopeClassIri === t && df(c.matchedText) <= keywordDf,
    );
    if (specificConcept) {
      kept.push(t);
      groundedBy[t] = specificConcept.kind === 'class' ? 'class' : specificConcept.kind;
      continue;
    }
    const specificValue = anchorSet.valueAnchors.find((v) => v.class === t && df(v.matchedKeyword) <= keywordDf);
    if (specificValue) {
      kept.push(t);
      groundedBy[t] = 'value';
      continue;
    }
    dropped.push({
      iri: t,
      reason: 'no exact-class/value anchor; all grounding keywords are generic (df > ' + keywordDf + ')',
    });
  }

  // --- Recall safety: never route over nothing. If pruning emptied the set, keep the
  //     single best-grounded candidate (a trivial single-terminal subgraph). ---
  if (kept.length === 0 && candidates.length > 0) {
    let best = candidates[0] as string;
    for (const t of candidates) if ((bestScore.get(t) ?? 0) > (bestScore.get(best) ?? 0)) best = t;
    kept.push(best);
    groundedBy[best] = 'class';
    const idx = dropped.findIndex((d) => d.iri === best);
    if (idx >= 0) dropped.splice(idx, 1);
  }

  return { terminals: kept, trace: { candidates, kept, dropped, groundedBy } };
}
