/**
 * Stage 1 (anchoring) — the matcher: question string → `AnchorSet`.
 *
 * Two retrievals, unioned (the field's value-retriever ∪ column-retriever, settled by
 * CHESS / XiYan-SQL / SDE-SQL — concept hits and value hits catch different things):
 *   • concept matcher — question n-grams vs the concept index (class/property/capability
 *     labels, names, descriptions), tiered lexical scoring;
 *   • value matcher   — question n-grams vs the column sample-value index, exact then fuzzy.
 *
 * Lexical-first, deterministic, no LLM and no embeddings (SING-SQL found dense search
 * slower; BM25/lexical is plenty at this scale). The `rerank` seam (default identity) is
 * where an embedding pass would slot in later, and keyword extraction is plain n-grams
 * rather than a few-shot LLM extractor — both kept as documented future seams.
 *
 * Recall-favoring by design: terminals OVER-return (a generous candidate set, never pruned
 * to one). Downstream prunes — Stage 2's Steiner keeps only the cheapest CONNECTED subset
 * (extra terminals that don't aid connectivity never join the tree) and Stage 3a's leash
 * rejects out-of-payload IRIs. Too few terminals is unrecoverable; a few extra are filtered.
 *
 * See docs/query/anchoring.md and docs/adr/005-anchoring.md.
 */
import { spans, tokenize, rawTokens, similarity, isCue } from './text-normalize.js';
import type { AnchorIndex, ConceptEntry } from './anchor-index.js';
import type { AnchorOpts, AnchorSet, ConceptAnchor, ValueAnchor } from './anchor-model.js';

/** Minimum concept score to keep a candidate (mirrors the linker's name-channel FLOOR). */
const FLOOR = 0.6;
/** Low-weight score for a description (rdfs:comment) containment hit. */
const COMMENT_SCORE = 0.72;
/** Confidence assigned to an exact value-dictionary hit (mirrors the linker's VALUE_SCORE). */
const VALUE_SCORE = 0.95;
/** Shortest span we will fuzzy-match against value keys (avoids tiny-token noise). */
const FUZZY_MIN_LEN = 4;

const DEFAULTS: Required<AnchorOpts> = {
  maxTerminals: 8,
  fuzzyThreshold: 0.82,
  rerank: (c) => c,
};

/** Best score of one span against one label/name surface (NOT description), in [0,1]. */
function labelScore(spanText: string, spanToks: string[], e: ConceptEntry, fuzzyThreshold: number): number {
  if (spanText === e.surface) return 1;
  const subset = spanToks.length < e.tokens.length && spanToks.every((x) => e.tokens.includes(x));
  if (subset) return 0.76 + 0.13 * (spanToks.length / e.tokens.length);
  if (spanText.length >= 4 && e.surface.includes(spanText)) return 0.8;
  if (spanToks.length === 1 && e.tokens.length === 1) {
    const sim = similarity(spanText, e.surface);
    if (sim >= fuzzyThreshold) return Math.min(0.9, sim);
  }
  return 0;
}

/** Score a span against a single concept entry (description entries use the low-weight rule). */
function scoreEntry(spanText: string, spanToks: string[], e: ConceptEntry, fuzzyThreshold: number): number {
  if (e.via === 'description') {
    // Only multi-word spans whose tokens are ALL in the comment — a weak corroborating signal.
    if (spanToks.length >= 2 && spanToks.every((x) => e.tokens.includes(x))) return COMMENT_SCORE;
    return 0;
  }
  return labelScore(spanText, spanToks, e, fuzzyThreshold);
}

interface ScoredConcept {
  anchor: ConceptAnchor;
  /** The class IRI this anchor implies as a terminal (tracked here; not part of ConceptAnchor). */
  scopeClassIri: string;
}

export function anchorQuestion(question: string, index: AnchorIndex, opts: AnchorOpts = {}): AnchorSet {
  const maxTerminals = opts.maxTerminals ?? DEFAULTS.maxTerminals;
  const fuzzyThreshold = opts.fuzzyThreshold ?? DEFAULTS.fuzzyThreshold;
  const rerank = opts.rerank ?? DEFAULTS.rerank;

  // Keyword extraction: deterministic uni/bi/tri-gram spans (no LLM).
  const conceptSpans = spans(tokenize(question), 3); // singularized — for label/name matching
  const valueSpans = spans(rawTokens(question), 3); // not singularized — for value matching
  const keywords = [...new Set([...conceptSpans, ...valueSpans])];

  // --- Concept matcher: best (score, via, span) per element IRI. ---
  const bestByIri = new Map<string, ScoredConcept>();
  for (const spanText of conceptSpans) {
    const spanToks = spanText.split(' ');
    // A lone aggregation cue ("average", "count", "total", …) is framing, not a concept name:
    // accept it only on an EXACT label hit, never as a weak subset of "average points" etc.
    // (mirrors the schema linker's `skippable` discipline). Multi-word spans are unaffected.
    const loneCue = spanToks.length === 1 && isCue(spanToks[0] as string);
    for (const e of index.concepts) {
      const score = scoreEntry(spanText, spanToks, e, fuzzyThreshold);
      if (score < FLOOR) continue;
      if (loneCue && score < 1) continue;
      const prev = bestByIri.get(e.iri);
      if (prev && prev.anchor.score >= score) continue;
      bestByIri.set(e.iri, {
        anchor: { kind: e.kind, iri: e.iri, matchedText: spanText, via: e.via, score },
        scopeClassIri: e.scopeClassIri,
      });
    }
  }
  const scoredConcepts = [...bestByIri.values()].sort(
    (a, b) => b.anchor.score - a.anchor.score || a.anchor.iri.localeCompare(b.anchor.iri),
  );
  // Apply the rerank seam (identity by default) to the concept anchors before deriving terminals.
  const conceptAnchors = rerank(scoredConcepts.map((s) => s.anchor));
  const scopeByIri = new Map(scoredConcepts.map((s) => [s.anchor.iri, s.scopeClassIri]));

  // --- Value matcher: exact dictionary hit, else single best fuzzy key per span. ---
  const valueByKey = new Map<string, ValueAnchor>();
  const addValue = (a: ValueAnchor): void => {
    const k = `${a.property}|${a.value}`;
    const prev = valueByKey.get(k);
    if (!prev || a.score > prev.score) valueByKey.set(k, a);
  };
  for (const spanText of valueSpans) {
    const exact = index.values.get(spanText);
    if (exact) {
      for (const v of exact) {
        addValue({ property: v.propertyIri, class: v.classIri, value: v.originalValue, matchedKeyword: spanText, score: VALUE_SCORE, matchType: 'exact' });
      }
      continue;
    }
    if (spanText.length < FUZZY_MIN_LEN) continue;
    let bestKey: string | null = null;
    let bestSim = fuzzyThreshold;
    for (const key of index.values.keys()) {
      const sim = similarity(spanText, key);
      if (sim >= bestSim && sim < 1) {
        bestSim = sim;
        bestKey = key;
      }
    }
    if (bestKey) {
      for (const v of index.values.get(bestKey) ?? []) {
        addValue({ property: v.propertyIri, class: v.classIri, value: v.originalValue, matchedKeyword: spanText, score: bestSim, matchType: 'fuzzy' });
      }
    }
  }
  const valueAnchors = [...valueByKey.values()];

  // --- Union → terminals (recall-favoring): classes implied by both matchers, best score wins. ---
  const classScore = new Map<string, number>();
  const bump = (iri: string, score: number): void => {
    const prev = classScore.get(iri);
    if (prev === undefined || score > prev) classScore.set(iri, score);
  };
  for (const a of conceptAnchors) bump(scopeByIri.get(a.iri) as string, a.score);
  for (const v of valueAnchors) bump(v.class, v.score);

  const union = [...classScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([iri]) => iri);
  const terminals = union.slice(0, maxTerminals);

  return {
    terminals,
    conceptAnchors,
    valueAnchors,
    trace: { keywords, conceptCandidates: conceptAnchors, valueCandidates: valueAnchors, union, terminals },
  };
}
