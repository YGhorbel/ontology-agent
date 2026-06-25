/**
 * Stage 2 (subgraph extraction) — graph data model.
 *
 * These are the in-memory shapes the deterministic router operates on. They are
 * deliberately IRI-keyed (class IRIs, not bare table names) so routing stays
 * faithful to the ontology and never has to re-resolve names. No logic lives here.
 *
 * See docs/query/subgraph.md (the Stage-3 contract + weight function) and
 * docs/adr/002-subgraph-extraction.md (RULES A/B/C).
 */

/** A trimmed column descriptor carried in a node and (after trimming) in the payload. */
export interface ColumnProp {
  col: string;
  dataType?: string;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  observedUnique?: boolean;
  /** Text column whose values parse as numbers — the SQL layer must CAST before aggregating/comparing. */
  isNumericText?: boolean;
  /** Cumulative running-total tag — the SQL layer aggregates such columns with MAX, not SUM. */
  temporality?: string;
  /**
   * Grain that justifies the cumulative tag: partition (entity + season) + within-season order.
   * Carried so Stage 3b can de-cumulate (snapshot-at-max-order per partition). Partition/order
   * columns may live on a CALENDAR table reached by a declared FK (e.g. races.year / races.round),
   * not on the measure table itself.
   */
  temporalityEvidence?: { partitionColumns: string[]; orderColumn: string; ratio: number };
  /**
   * Enum/profile sample values. For terminal classes the payload carries the FULL domain when the
   * enum is exhaustive (`distinctCount <= sampleValues.length` — the generator only emits samples
   * when `distinctCount <= ONTOLOGY_ENUM_MAX_DISTINCT`, so presence ⇒ full domain); non-exhaustive
   * sampled columns are truncated to 15. Carried so the leash can value-ground filter literals.
   */
  sampleValues?: string[];
  /** Total distinct values in the column (from profiling). Pairs with sampleValues to mark a column
   * enumerable (exhaustive enum) for filter value-grounding. See docs/adr/009-value-grounding.md. */
  distinctCount?: number;
}

/** One join edge between two classes. A composite FK is ONE edge with >=2 columnPairs (RULE B). */
export interface JoinEdge {
  /** Class IRI this copy routes FROM (swapped on the reverse adjacency copy). */
  from: string;
  /** Class IRI this copy routes TO. */
  to: string;
  /** Routing cost = max(1 - confidence, tier floor), or 1 in uniform mode (RULE C). */
  weight: number;
  confidence: number;
  provenance: 'declared' | 'discovered' | 'inferred-name';
  /** length 1 for a unary FK, >=2 for a composite. Oriented to match this copy's from->to. */
  columnPairs: { fromCol: string; toCol: string }[];
  /** Original FK direction (domain IRI) — stable across both adjacency copies. */
  domain: string;
  /** Original FK direction (range IRI) — stable across both adjacency copies. */
  range: string;
  /** Source object-property `@id` in `@graph` (never a candidate-graph IRI). */
  sourceIri: string;
}

/** A class (table) node with its (untrimmed) columns. */
export interface ClassNode {
  iri: string;
  table: string;
  properties: ColumnProp[];
}

/** The routable ontology graph: nodes + undirected adjacency (each edge appears on both endpoints). */
export interface OntologyGraph {
  nodes: Map<string, ClassNode>;
  adjacency: Map<string, JoinEdge[]>;
}

/** A capability whose scope class is in the extracted tree, surfaced to Stage 3. */
export interface CapabilityRef {
  iri: string;
  kind: string;
  scopeClass: string;
  scopeProperty?: string;
  prefLabel?: string;
  /** Pre-validated SQL aggregate (e.g. `AVG(laptimes.milliseconds)`); the compiler expands it verbatim. */
  formulaHint?: string;
  /** Unit of the metric result (e.g. `ms`, `points`) — carried for the certificate/trace. */
  unit?: string;
}

/** The Stage-3 contract: a trimmed, self-contained description of the chosen subgraph. */
export interface SubgraphPayload {
  classes: { iri: string; properties: ColumnProp[] }[];
  joins: {
    from: string;
    to: string;
    on: [string, string][];
    provenance: JoinEdge['provenance'];
    confidence: number;
  }[];
  capabilities: CapabilityRef[];
  /** MIN over tree-edge confidences (weakest link). 1 for a trivial/no-edge payload. */
  aggregateConfidence: number;
  /** Tree nodes that are not terminals (the Steiner points the compiler must pass through). */
  bridgeNodes: string[];
  /** Sum of tree edge weights. 0 for a trivial payload. */
  totalCost: number;
  /** Set when one or more terminal pairs were unreachable (best partial forest returned). */
  disconnected?: boolean;
}

/** Options for extraction. `uniform` is the H1 flip; `k` is reserved for Yen's k-shortest (stub). */
export interface ExtractOpts {
  /** Force every edge weight to 1 (ignore confidence/floors) — demonstrates the weight function's effect. */
  uniform?: boolean;
  /** Reserved: number of alternative trees (Yen's k-shortest). Only k=1 (single best) is implemented. */
  k?: number;
  /** Anchored columns per class IRI (from Stage 1) — always retained by the payload trimmer. */
  anchoredColumns?: Map<string, string[]>;
}
