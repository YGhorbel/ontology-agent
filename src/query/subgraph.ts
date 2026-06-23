/**
 * Stage 2 — Steiner subgraph extraction (metric-closure + MST 2-approximation).
 *
 * Given terminal classes (from Stage 1 anchoring) the router returns the cheapest
 * tree connecting them, then trims it into a `SubgraphPayload` (the Stage-3 contract).
 * No LLM, no DB. See docs/query/subgraph.md and docs/adr/002-subgraph-extraction.md.
 *
 * Determinism: edge cost (RULE C) is the primary key. Among equal-cost paths a fixed
 * TIE-BREAK applies (documented in ADR-002): prefer higher min-confidence, then fewer
 * hops, then fewer composite edges, then the lexicographically smaller ordered list of
 * source IRIs. `aggregateConfidence` is the MIN edge confidence in the tree (weakest link).
 */
import type {
  CapabilityRef,
  ClassNode,
  ColumnProp,
  ExtractOpts,
  JoinEdge,
  OntologyGraph,
  SubgraphPayload,
} from './graph-model.js';

const MAX_SAMPLE_VALUES = 15;

interface PathInfo {
  cost: number;
  minConf: number;
  hops: number;
  comps: number;
  /** Edges oriented along traversal (edge.from is the predecessor). */
  edges: JoinEdge[];
  /** Ordered source IRIs, for the lexicographic tie-break. */
  iris: string[];
}

const START: PathInfo = { cost: 0, minConf: 1, hops: 0, comps: 0, edges: [], iris: [] };

/** Is path `a` strictly preferable to path `b`? (cost, then the documented tie-break.) */
function better(a: PathInfo, b: PathInfo): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.minConf !== b.minConf) return a.minConf > b.minConf;
  if (a.hops !== b.hops) return a.hops < b.hops;
  if (a.comps !== b.comps) return a.comps < b.comps;
  return a.iris.join('|') < b.iris.join('|');
}

const isComposite = (e: JoinEdge): boolean => e.columnPairs.length >= 2;

function extend(prev: PathInfo, e: JoinEdge): PathInfo {
  return {
    cost: prev.cost + e.weight,
    minConf: Math.min(prev.minConf, e.confidence),
    hops: prev.hops + 1,
    comps: prev.comps + (isComposite(e) ? 1 : 0),
    edges: [...prev.edges, e],
    iris: [...prev.iris, e.sourceIri],
  };
}

/** Label-setting Dijkstra from `src` over edge weights, with the tie-break baked in. */
function dijkstra(graph: OntologyGraph, src: string): Map<string, PathInfo> {
  const best = new Map<string, PathInfo>([[src, START]]);
  const settled = new Set<string>();
  while (settled.size < best.size) {
    // Pick the unsettled node with the best label.
    let u: string | undefined;
    let bu: PathInfo | undefined;
    for (const [node, info] of best) {
      if (settled.has(node)) continue;
      if (bu === undefined || better(info, bu)) {
        u = node;
        bu = info;
      }
    }
    if (u === undefined || bu === undefined) break;
    settled.add(u);
    for (const e of graph.adjacency.get(u) ?? []) {
      const cand = extend(bu, e);
      const cur = best.get(e.to);
      if (cur === undefined || better(cand, cur)) best.set(e.to, cand);
    }
  }
  return best;
}

// ---- Union-find (for Kruskal over the terminal metric closure and tree pruning) ----
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (p !== x) {
      x = p;
      p = this.parent.get(x)!;
    }
    return x;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

interface MetaEdge {
  u: string;
  v: string;
  dist: number;
  hops: number;
  iris: string;
  edges: JoinEdge[];
}

/**
 * Deterministic ordering of meta-edges, as a lexicographic objective tuple:
 *   1. distance (total path COST — primary; confidence/provenance weights win first),
 *   2. hops (EDGE COUNT — secondary: prefer fewer joins among cost-tied paths; this is the
 *      sole place tree cardinality is decided, since the metric-closure MST fixes the node
 *      set and the final spanning tree then has nodes−1 edges regardless),
 *   3. ordered source-IRI list (the existing lexicographic determinism tie-break).
 * Node count is omitted: for a tree/simple path nodes = edges + 1, so `hops` subsumes it.
 * Cardinality is a strictly secondary key — a costlier fewer-edge path NEVER beats a cheaper one.
 */
function metaLess(a: MetaEdge, b: MetaEdge): number {
  if (a.dist !== b.dist) return a.dist - b.dist;
  if (a.hops !== b.hops) return a.hops - b.hops;
  return a.iris < b.iris ? -1 : a.iris > b.iris ? 1 : 0;
}

/** Spanning tree (Kruskal MST by weight, tie-break source IRI) over a set of real edges. */
function mstOverEdges(edges: JoinEdge[]): JoinEdge[] {
  const sorted = [...edges].sort((a, b) =>
    a.weight !== b.weight ? a.weight - b.weight : a.sourceIri < b.sourceIri ? -1 : a.sourceIri > b.sourceIri ? 1 : 0,
  );
  const uf = new UnionFind();
  const out: JoinEdge[] = [];
  for (const e of sorted) {
    if (uf.union(e.from, e.to)) out.push(e);
  }
  return out;
}

/** Drop degree-1 non-terminal leaves repeatedly so only Steiner points that branch remain. */
function pruneLeaves(edges: JoinEdge[], terminals: Set<string>): JoinEdge[] {
  let cur = edges;
  for (;;) {
    const degree = new Map<string, number>();
    for (const e of cur) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const leaves = new Set<string>();
    for (const [node, d] of degree) {
      if (d === 1 && !terminals.has(node)) leaves.add(node);
    }
    if (leaves.size === 0) return cur;
    cur = cur.filter((e) => !leaves.has(e.from) && !leaves.has(e.to));
  }
}

/** Canonical (domain -> range) column pairs for a tree edge, regardless of traversal direction. */
function canonicalPairs(e: JoinEdge): [string, string][] {
  return e.from === e.domain
    ? e.columnPairs.map((p) => [p.fromCol, p.toCol] as [string, string])
    : e.columnPairs.map((p) => [p.toCol, p.fromCol] as [string, string]);
}

/**
 * Trim a class node's columns to: (a) join keys, (b) anchored columns, and (c) for TERMINAL
 * classes only, their enum columns' sample values (truncated to 15). Sample values are carried
 * only by terminal classes; bridge-node columns never carry them (context discipline).
 */
function trimColumns(
  node: ClassNode,
  joinCols: Set<string>,
  isTerminal: boolean,
  anchored: string[],
): ColumnProp[] {
  const keep = new Set<string>(joinCols);
  for (const a of anchored) keep.add(a);
  if (isTerminal) {
    for (const prop of node.properties) {
      if (prop.sampleValues && prop.sampleValues.length > 0) keep.add(prop.col);
    }
  }
  const out: ColumnProp[] = [];
  for (const prop of node.properties) {
    if (!keep.has(prop.col)) continue;
    const clone: ColumnProp = { ...prop };
    if (clone.sampleValues) {
      // Only terminals carry sample values, and never more than 15.
      if (isTerminal) clone.sampleValues = clone.sampleValues.slice(0, MAX_SAMPLE_VALUES);
      else delete clone.sampleValues;
    }
    out.push(clone);
  }
  // Anchored/join columns absent from the node's property list still surface (minimal shape).
  for (const col of keep) {
    if (!node.properties.some((p) => p.col === col)) out.push({ col });
  }
  return out;
}

/**
 * Extract the cheapest tree connecting `terminals` and trim it to a `SubgraphPayload`.
 *
 * @param graph        routable ontology graph (from buildGraph)
 * @param terminals    class IRIs that must be connected (Stage 1 output)
 * @param anchors      class IRIs treated as anchored (their anchored columns are always kept)
 * @param capabilities capability refs (only those scoped to a tree node are surfaced)
 */
export function extractSubgraph(
  graph: OntologyGraph,
  terminals: string[],
  anchors: string[],
  capabilities: CapabilityRef[],
  opts: ExtractOpts = {},
): SubgraphPayload {
  if (opts.k !== undefined && opts.k > 1) {
    // Reserved for Yen's k-shortest; only the single best tree is implemented.
    throw new Error('extractSubgraph: k>1 (Yen k-shortest trees) is not implemented yet');
  }
  const termSet = new Set(terminals);
  // `anchors` (anchored class IRIs) reserved for Stage-1 wiring; anchored COLUMNS arrive via opts.
  void anchors;
  const anchoredColumns = opts.anchoredColumns ?? new Map<string, string[]>();

  // --- Trivial case: 0 or 1 terminal -> single-node payload, no routing. ---
  if (termSet.size <= 1) {
    const classes = [...termSet].flatMap((iri) => {
      const node = graph.nodes.get(iri);
      if (!node) return [];
      const props = trimColumns(node, new Set<string>(), true, anchoredColumns.get(iri) ?? []);
      return [{ iri, properties: props }];
    });
    return {
      classes,
      joins: [],
      capabilities: capabilities.filter((c) => termSet.has(c.scopeClass)),
      aggregateConfidence: 1,
      bridgeNodes: [],
      totalCost: 0,
    };
  }

  // --- Metric closure: shortest path between every terminal pair. ---
  const termList = [...termSet];
  const paths = new Map<string, Map<string, PathInfo>>();
  for (const t of termList) paths.set(t, dijkstra(graph, t));

  const metaEdges: MetaEdge[] = [];
  let disconnected = false;
  for (let i = 0; i < termList.length; i++) {
    for (let j = i + 1; j < termList.length; j++) {
      const u = termList[i]!;
      const v = termList[j]!;
      const info = paths.get(u)!.get(v);
      if (!info) {
        disconnected = true;
        continue;
      }
      metaEdges.push({ u, v, dist: info.cost, hops: info.hops, iris: info.iris.join('|'), edges: info.edges });
    }
  }

  // --- Kruskal MST over terminals; expand selected meta-edges back to real edges. ---
  metaEdges.sort(metaLess);
  const uf = new UnionFind();
  const unioned: JoinEdge[] = [];
  for (const me of metaEdges) {
    if (uf.union(me.u, me.v)) unioned.push(...me.edges);
  }
  // If terminals fall into multiple components, the result is a partial forest.
  const roots = new Set(termList.map((t) => uf.find(t)));
  if (roots.size > 1) disconnected = true;

  // --- Dedupe by source IRI, remove cycles (MST over the union), prune incidental leaves. ---
  const dedup = new Map<string, JoinEdge>();
  for (const e of unioned) if (!dedup.has(e.sourceIri)) dedup.set(e.sourceIri, e);
  let treeEdges = mstOverEdges([...dedup.values()]);
  treeEdges = pruneLeaves(treeEdges, termSet);

  // --- Assemble the tree node set, costs, and confidence. ---
  const treeNodes = new Set<string>(termSet);
  for (const e of treeEdges) {
    treeNodes.add(e.from);
    treeNodes.add(e.to);
  }
  const totalCost = treeEdges.reduce((s, e) => s + e.weight, 0);
  const aggregateConfidence = treeEdges.length === 0 ? 1 : Math.min(...treeEdges.map((e) => e.confidence));
  const bridgeNodes = [...treeNodes].filter((n) => !termSet.has(n)).sort();

  // --- Per-node kept join columns (canonical orientation). ---
  const keepByNode = new Map<string, Set<string>>();
  const ensure = (iri: string): Set<string> => {
    let s = keepByNode.get(iri);
    if (!s) {
      s = new Set<string>();
      keepByNode.set(iri, s);
    }
    return s;
  };
  for (const e of treeEdges) {
    const pairs = canonicalPairs(e);
    for (const [domCol, rngCol] of pairs) {
      ensure(e.domain).add(domCol);
      ensure(e.range).add(rngCol);
    }
  }

  // --- Trimmed classes. ---
  const classes = [...treeNodes]
    .sort()
    .flatMap((iri) => {
      const node = graph.nodes.get(iri);
      if (!node) return [];
      const props = trimColumns(
        node,
        new Set(keepByNode.get(iri) ?? []),
        termSet.has(iri),
        anchoredColumns.get(iri) ?? [],
      );
      return [{ iri, properties: props }];
    });

  // --- Joins (canonical domain -> range orientation, deterministic). ---
  const joins = treeEdges
    .map((e) => ({
      from: e.domain,
      to: e.range,
      on: canonicalPairs(e),
      provenance: e.provenance,
      confidence: e.confidence,
    }))
    .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : a.from + a.to > b.from + b.to ? 1 : 0));

  const payload: SubgraphPayload = {
    classes,
    joins,
    capabilities: capabilities.filter((c) => treeNodes.has(c.scopeClass)),
    aggregateConfidence,
    bridgeNodes,
    totalCost,
  };
  if (disconnected) payload.disconnected = true;
  return payload;
}
