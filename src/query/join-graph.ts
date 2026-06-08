/**
 * Join-path resolver (pure, zero-dependency).
 *
 * Builds an undirected weighted graph from the ontology's join edges and, given a
 * set of requested tables, returns the exact JOIN clauses that connect them. This
 * is what turns "which JOINs?" from an LLM guess into a deterministic graph search
 * — the payoff of the FK/relationship discovery work.
 *
 * Edge weight = 1 / confidence², so declared FKs (confidence 1 → weight 1) are
 * decisively preferred: a coincidental discovered edge (confidence 0.5 → weight 4)
 * cannot beat a two-hop all-declared path (weight 2), while a legitimate discovered
 * FK (0.78 → ~1.6) stays cheap. Two tables → Dijkstra shortest path; N tables →
 * a Steiner-tree 2-approximation (metric closure → Prim MST → expand).
 */
import type { JoinEdge, JoinClause, JoinPath } from '../types/query-plan.js';

const EPS = 1e-6;

/** Undirected edge: (a.aCol) == (b.bCol). `weight` ranks it for shortest-path. */
export interface GraphEdge {
  a: string;
  aCol: string;
  b: string;
  bCol: string;
  cardinality: JoinEdge['cardinality'];
  confidence: number;
  provenance: JoinEdge['provenance'];
  weight: number;
}
export type JoinGraph = Map<string, GraphEdge[]>;

const pairKey = (x: string, y: string): string => [x, y].sort().join(' ');
const edgeKey = (e: GraphEdge): string => [`${e.a}.${e.aCol}`, `${e.b}.${e.bCol}`].sort().join('=');
const other = (e: GraphEdge, t: string): string => (t === e.a ? e.b : e.a);
const colOf = (e: GraphEdge, t: string): string => (t === e.a ? e.aCol : e.bCol);

function pushEdge(adj: JoinGraph, t: string, e: GraphEdge): void {
  const list = adj.get(t);
  if (list) list.push(e);
  else adj.set(t, [e]);
}

/** Build the adjacency graph; self-references are skipped and parallel edges collapse to the lowest weight. */
export function buildJoinGraph(edges: JoinEdge[]): JoinGraph {
  const best = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (e.fromTable === e.toTable) continue; // self-reference: not useful for connecting distinct tables
    const c = Math.max(e.confidence, EPS);
    const weight = 1 / (c * c); // 1/confidence² — declared edges decisively beat coincidental ones
    const ge: GraphEdge = {
      a: e.fromTable,
      aCol: e.fromColumn,
      b: e.toTable,
      bCol: e.toColumn,
      cardinality: e.cardinality,
      confidence: e.confidence,
      provenance: e.provenance,
      weight,
    };
    const key = pairKey(e.fromTable, e.toTable);
    const prev = best.get(key);
    if (!prev || weight < prev.weight) best.set(key, ge);
  }

  const adj: JoinGraph = new Map();
  for (const e of best.values()) {
    pushEdge(adj, e.a, e);
    pushEdge(adj, e.b, e);
  }
  return adj;
}

/** Dijkstra from `source`; returns dist + the edge used to reach each node. */
function dijkstra(adj: JoinGraph, source: string): { dist: Map<string, number>; prevEdge: Map<string, GraphEdge> } {
  const dist = new Map<string, number>([[source, 0]]);
  const prevEdge = new Map<string, GraphEdge>();
  const visited = new Set<string>();

  for (;;) {
    let u: string | undefined;
    let bestDist = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < bestDist) {
        bestDist = d;
        u = node;
      }
    }
    if (u === undefined) break;
    visited.add(u);
    for (const e of adj.get(u) ?? []) {
      const v = other(e, u);
      const nd = bestDist + e.weight;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prevEdge.set(v, e);
      }
    }
  }
  return { dist, prevEdge };
}

/** Reconstruct the edge list from source to target (empty if equal, null if disconnected). */
function pathEdges(source: string, target: string, prevEdge: Map<string, GraphEdge>): GraphEdge[] | null {
  if (source === target) return [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  let cur = target;
  while (cur !== source) {
    const e = prevEdge.get(cur);
    if (!e || seen.has(cur)) return null;
    seen.add(cur);
    edges.push(e);
    cur = other(e, cur);
  }
  return edges.reverse();
}

export interface ResolveOptions {
  /** Tables to prefer as the FROM anchor (e.g. capability fact tables). */
  factTables?: string[];
  /** Minimum edge confidence for the primary (trusted) pass. Default 0.5. */
  minConfidence?: number;
  /** Fall back to the full graph (incl. low-confidence edges) for otherwise-unreachable tables. Default true. */
  allowLowConfidenceFallback?: boolean;
}

/** Keep only edges at or above `minConfidence` (both endpoints stay consistent). */
function filterGraph(adj: JoinGraph, minConfidence: number): JoinGraph {
  const out: JoinGraph = new Map();
  for (const [t, edges] of adj) {
    const kept = edges.filter((e) => e.confidence >= minConfidence);
    if (kept.length > 0) out.set(t, kept);
  }
  return out;
}

function chooseAnchor(terminals: string[], sub: JoinGraph, factTables: string[] | undefined): string {
  const fact = terminals.find((t) => factTables?.includes(t));
  if (fact) return fact;
  let best = terminals[0] as string;
  let bestDegree = -1;
  for (const t of terminals) {
    const degree = (sub.get(t) ?? []).length;
    if (degree > bestDegree) {
      bestDegree = degree;
      best = t;
    }
  }
  return best;
}

type PartialPath = Pick<JoinPath, 'anchorTable' | 'clauses' | 'unreachable'>;

/** Steiner-tree resolution over a single (already-filtered) graph. */
function resolveOnGraph(adj: JoinGraph, terminals: string[], opts: ResolveOptions): PartialPath {
  // Dijkstra once per terminal, then build the metric closure among reachable pairs.
  const runs = new Map<string, ReturnType<typeof dijkstra>>();
  for (const t of terminals) runs.set(t, dijkstra(adj, t));

  interface Closure { u: string; v: string; dist: number; edges: GraphEdge[] }
  const closures: Closure[] = [];
  for (let i = 0; i < terminals.length; i += 1) {
    for (let j = i + 1; j < terminals.length; j += 1) {
      const u = terminals[i] as string;
      const v = terminals[j] as string;
      const run = runs.get(u) as ReturnType<typeof dijkstra>;
      const d = run.dist.get(v);
      if (d === undefined) continue;
      const edges = pathEdges(u, v, run.prevEdge);
      if (edges) closures.push({ u, v, dist: d, edges });
    }
  }

  // Prim MST over terminals using the closure edges → 2-approx Steiner tree.
  const inTree = new Set<string>([terminals[0] as string]);
  const chosen: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  while (inTree.size < terminals.length) {
    let bestClosure: Closure | undefined;
    for (const c of closures) {
      if (inTree.has(c.u) !== inTree.has(c.v) && (!bestClosure || c.dist < bestClosure.dist)) bestClosure = c;
    }
    if (!bestClosure) break; // remaining terminals are unreachable
    inTree.add(bestClosure.u);
    inTree.add(bestClosure.v);
    for (const e of bestClosure.edges) {
      const k = edgeKey(e);
      if (!seenEdge.has(k)) {
        seenEdge.add(k);
        chosen.push(e);
      }
    }
  }

  const unreachable = terminals.filter((t) => !inTree.has(t));

  // Subgraph of chosen edges, then BFS from the anchor to order the JOINs.
  const sub: JoinGraph = new Map();
  for (const e of chosen) {
    pushEdge(sub, e.a, e);
    pushEdge(sub, e.b, e);
  }
  const anchor = chooseAnchor(terminals.filter((t) => inTree.has(t)), sub, opts.factTables);

  const clauses: JoinClause[] = [];
  const visited = new Set<string>([anchor]);
  const queue: string[] = [anchor];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const e of sub.get(node) ?? []) {
      const nb = other(e, node);
      if (visited.has(nb)) continue;
      visited.add(nb);
      queue.push(nb);
      clauses.push({
        joinTable: nb,
        on: { left: `${node}.${colOf(e, node)}`, right: `${nb}.${colOf(e, nb)}` },
        cardinality: e.cardinality,
        confidence: e.confidence,
        provenance: e.provenance,
      });
    }
  }

  return { anchorTable: anchor, clauses, unreachable };
}

/**
 * Resolve the JOIN path connecting `tables`, tiered by trust: first over the
 * *trusted* graph (edges ≥ `minConfidence`), and only if that leaves tables
 * unreachable does it fall back to the full graph (incl. low-confidence
 * discovered edges) — flagging the result `lowConfidence`. Each clause carries its
 * own confidence/provenance so callers can see exactly how much to trust each hop.
 */
export function resolveJoinPath(adj: JoinGraph, tables: string[], opts: ResolveOptions = {}): JoinPath {
  const terminals = [...new Set(tables)];
  if (terminals.length === 0) return { anchorTable: '', clauses: [], unreachable: [], lowConfidence: false };
  if (terminals.length === 1) return { anchorTable: terminals[0] as string, clauses: [], unreachable: [], lowConfidence: false };

  const minConfidence = opts.minConfidence ?? 0.5;
  const allowFallback = opts.allowLowConfidenceFallback ?? true;

  const primary = resolveOnGraph(filterGraph(adj, minConfidence), terminals, opts);
  if (primary.unreachable.length === 0 || !allowFallback) {
    return { ...primary, lowConfidence: false };
  }

  // Fallback: the trusted graph couldn't connect everything — use the full graph.
  const full = resolveOnGraph(adj, terminals, opts);
  if (full.unreachable.length < primary.unreachable.length) {
    const usedLowConfidence = full.clauses.some((c) => c.confidence < minConfidence);
    return { ...full, lowConfidence: usedLowConfidence };
  }
  return { ...primary, lowConfidence: false };
}
