/**
 * Stage 1 (anchoring) — data model.
 *
 * Anchoring is the NL2SQL FRONT DOOR: it turns a raw question string into the inputs
 * Stage 2 (`extractSubgraph`) consumes — the recall-favoring set of candidate
 * `terminals` (class IRIs the answer must touch) plus the concept/value anchors that
 * justify them. No live DB: matching is a static-index lookup over the generator's
 * pre-computed `qsl:sampleValues` (value index) and SKOS labels (concept index).
 *
 * See docs/query/anchoring.md (the S1→S2 contract) and docs/adr/005-anchoring.md
 * (hybrid+union, lexical-first, recall-favoring decisions). No logic lives here.
 */

/** A lexical hit against the concept index (a class, property, or capability label/name). */
export interface ConceptAnchor {
  kind: 'class' | 'property' | 'capability';
  /** The matched element's IRI (class/property/capability `@id`). */
  iri: string;
  /**
   * The class IRI this anchor grounds as a terminal — its scope/owning class.
   * For a `class` anchor this equals `iri`; for `property`/`capability` it is the
   * owning/scope class. Exposed (not just used internally) so Stage-2 pruning can
   * reconstruct anchor provenance from the `AnchorSet` alone. See src/query/prune.ts.
   */
  scopeClassIri: string;
  /** The question span (normalized) that produced the hit. */
  matchedText: string;
  /** Which surface field of the element the span matched. */
  via: 'prefLabel' | 'altLabel' | 'description' | 'token';
  /** Tiered lexical score in [0,1] (1 = exact phrase). */
  score: number;
}

/** A fuzzy/exact hit of a question keyword against a column's pre-computed sample values. */
export interface ValueAnchor {
  /** Datatype-property IRI of the column carrying the matched value. */
  property: string;
  /** Class IRI owning that column (the terminal this anchor implies). */
  class: string;
  /** The matched sample value, in its ORIGINAL casing (e.g. "British"). */
  value: string;
  /** The question keyword (normalized) that matched it. */
  matchedKeyword: string;
  /** Value-match confidence in [0,1]. */
  score: number;
  matchType: 'exact' | 'fuzzy';
}

/** Enough to debug the union: keywords, per-matcher candidates pre-union, the union, terminals. */
export interface AnchorTrace {
  /** Distinct question spans considered (uni/bi/tri-grams). */
  keywords: string[];
  /** Concept-matcher output before union. */
  conceptCandidates: ConceptAnchor[];
  /** Value-matcher output before union. */
  valueCandidates: ValueAnchor[];
  /** All class IRIs implied by the two matchers, before the `maxTerminals` cap. */
  union: string[];
  /** The final capped terminal set (mirrors `AnchorSet.terminals`). */
  terminals: string[];
}

/** The S1→S2 contract: the recall-favoring candidate set + the anchors that justify it. */
export interface AnchorSet {
  /** Candidate class IRIs for Stage 2 to route over. Recall-favoring (over-returned, not pruned). */
  terminals: string[];
  conceptAnchors: ConceptAnchor[];
  valueAnchors: ValueAnchor[];
  trace: AnchorTrace;
}

/** Tunables. Defaults bias toward recall; the rerank seam is where embeddings would slot in later. */
export interface AnchorOpts {
  /** Generous cap on candidate terminals (NOT a tight one). Default 8. */
  maxTerminals?: number;
  /** Min edit-distance similarity for a fuzzy value match. Default 0.82 (= linker's FUZZY_MIN). */
  fuzzyThreshold?: number;
  /** Deferred embedding/rerank seam, applied to concept anchors before the cap. Default identity. */
  rerank?: (c: ConceptAnchor[]) => ConceptAnchor[];
}
