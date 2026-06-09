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
 *
 * Beyond the single best path it also synthesizes **co-reference** edges (sibling
 * fact tables sharing ≥2 FK parents get a direct multi-key join), flags **fan-out**
 * (row-multiplying hops), and enumerates the **K-best** alternative paths (Yen's
 * algorithm) as scored candidates for a downstream LLM to choose from.
 */
import type { JoinEdge, JoinClause, JoinPath, JoinPathCandidate } from '../types/query-plan.js';

const EPS = 1e-6;
/** Edges at or above this confidence are "trusted"; also the floor for building co-references. */
const TRUST_FLOOR = 0.5;

/** Confidence assigned to a synthesized co-reference edge. Tuned so a 1-hop co-ref
 * (weight 1/0.75²≈1.78) beats a 2-hop all-declared dimension detour (weight 2.0). */
const corefConfidenceFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_COREF_CONFIDENCE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
};

/** One join key pair in the edge's a→b orientation. */
interface ColPair {
  aCol: string;
  bCol: string;
}

/** Undirected edge: for every pair, (a.aCol) == (b.bCol). `weight` ranks it for shortest-path. */
export interface GraphEdge {
  a: string;
  b: string;
  cols: ColPair[];
  cardinality: JoinEdge['cardinality'];
  confidence: number;
  provenance: JoinEdge['provenance'];
  weight: number;
}
export type JoinGraph = Map<string, GraphEdge[]>;

const pairKey = (x: string, y: string): string => [x, y].sort().join(' ');
const colsKey = (e: GraphEdge): string =>
  e.cols.map((c) => [c.aCol, c.bCol].sort().join(':')).sort().join(',');
const edgeKey = (e: GraphEdge): string => `${pairKey(e.a, e.b)}|${colsKey(e)}`;
const other = (e: GraphEdge, t: string): string => (t === e.a ? e.b : e.a);

/** Oriented ON equalities for joining `to` onto `from` (left = from-side, right = to-side). */
function onPairs(e: GraphEdge, from: string): Array<{ left: string; right: string }> {
  const to = other(e, from);
  return e.cols.map((c) => {
    const fromCol = from === e.a ? c.aCol : c.bCol;
    const toCol = from === e.a ? c.bCol : c.aCol;
    return { left: `${from}.${fromCol}`, right: `${to}.${toCol}` };
  });
}

function pushEdge(adj: JoinGraph, t: string, e: GraphEdge): void {
  const list = adj.get(t);
  if (list) list.push(e);
  else adj.set(t, [e]);
}

function edgeFromJoin(e: JoinEdge): GraphEdge {
  const c = Math.max(e.confidence, EPS);
  const cols: ColPair[] = [
    { aCol: e.fromColumn, bCol: e.toColumn },
    ...e.extraColumns.map((x) => ({ aCol: x.from, bCol: x.to })),
  ];
  return {
    a: e.fromTable,
    b: e.toTable,
    cols,
    cardinality: e.cardinality,
    confidence: e.confidence,
    provenance: e.provenance,
    weight: 1 / (c * c), // 1/confidence² — declared edges decisively beat coincidental ones
  };
}

/**
 * Synthesize co-reference edges: two sibling tables that each reference the same ≥2
 * parent tables (e.g. `qualifying` and `results` both → races, drivers) can join
 * directly on those shared FK columns. Joining through a single shared dimension
 * silently fans out; the composite co-reference (raceid AND driverid) is the
 * correct-grain join. Only built on trusted FKs and only when no direct edge exists.
 */
export function synthesizeCoReferenceEdges(edges: JoinEdge[]): JoinEdge[] {
  // parentsBySource[A] = Map<parentTable, sourceColumn> (best-confidence FK per parent).
  const parentsBySource = new Map<string, Map<string, { col: string; conf: number }>>();
  const directPairs = new Set<string>();
  for (const e of edges) {
    if (e.fromTable === e.toTable) continue;
    if (e.confidence < TRUST_FLOOR) continue; // a noise edge is not a real FK — must not block co-ref
    directPairs.add(pairKey(e.fromTable, e.toTable));
    const m = parentsBySource.get(e.fromTable) ?? new Map<string, { col: string; conf: number }>();
    const prev = m.get(e.toTable);
    if (!prev || e.confidence > prev.conf) m.set(e.toTable, { col: e.fromColumn, conf: e.confidence });
    parentsBySource.set(e.fromTable, m);
  }

  const sources = [...parentsBySource.keys()].sort();
  const conf = corefConfidenceFromEnv();
  const out: JoinEdge[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const A = sources[i] as string;
      const B = sources[j] as string;
      if (directPairs.has(pairKey(A, B))) continue; // already directly joinable
      const pa = parentsBySource.get(A) as Map<string, { col: string; conf: number }>;
      const pb = parentsBySource.get(B) as Map<string, { col: string; conf: number }>;
      const shared = [...pa.keys()].filter((p) => pb.has(p)).sort();
      if (shared.length < 2) continue; // 1 shared parent = the fan-trap route; not synthesized
      const keyPairs = shared.map((p) => ({
        from: (pa.get(p) as { col: string }).col,
        to: (pb.get(p) as { col: string }).col,
      }));
      const [first, ...rest] = keyPairs;
      out.push({
        fromTable: A,
        fromColumn: (first as { from: string; to: string }).from,
        toTable: B,
        toColumn: (first as { from: string; to: string }).to,
        extraColumns: rest,
        cardinality: 'many-to-many',
        confidence: conf,
        provenance: 'co-reference',
      });
    }
  }
  return out;
}

/**
 * Build the adjacency graph; self-references are skipped and parallel edges collapse
 * to the lowest weight. Co-reference edges (sibling tables sharing ≥2 FK parents) are
 * synthesized and unioned in unless `coReference` is disabled.
 */
export function buildJoinGraph(edges: JoinEdge[], opts: { coReference?: boolean } = {}): JoinGraph {
  const all = opts.coReference === false ? edges : [...edges, ...synthesizeCoReferenceEdges(edges)];
  const best = new Map<string, GraphEdge>();
  for (const e of all) {
    if (e.fromTable === e.toTable) continue; // self-reference: not useful for connecting distinct tables
    const ge = edgeFromJoin(e);
    const key = pairKey(e.fromTable, e.toTable);
    const prev = best.get(key);
    if (!prev || ge.weight < prev.weight) best.set(key, ge);
  }

  const adj: JoinGraph = new Map();
  for (const e of best.values()) {
    pushEdge(adj, e.a, e);
    pushEdge(adj, e.b, e);
  }
  return adj;
}

/** Dijkstra from `source`; returns dist + the edge used to reach each node.
 * `blockedEdges`/`blockedNodes` (Yen's spur search) exclude edges/nodes from relaxation. */
function dijkstra(
  adj: JoinGraph,
  source: string,
  blockedEdges?: Set<string>,
  blockedNodes?: Set<string>,
): { dist: Map<string, number>; prevEdge: Map<string, GraphEdge> } {
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
      if (blockedEdges?.has(edgeKey(e))) continue;
      const v = other(e, u);
      if (blockedNodes?.has(v)) continue;
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

/** Shortest path source→target as an edge list, honoring Yen's blocked sets. */
function shortestPath(
  adj: JoinGraph,
  source: string,
  target: string,
  blockedEdges?: Set<string>,
  blockedNodes?: Set<string>,
): GraphEdge[] | null {
  if (source === target) return [];
  const { dist, prevEdge } = dijkstra(adj, source, blockedEdges, blockedNodes);
  if (dist.get(target) === undefined) return null;
  return pathEdges(source, target, prevEdge);
}

/** Node sequence [source, …, target] implied by an edge chain from `source`. */
function nodesOf(source: string, edges: GraphEdge[]): string[] {
  const nodes = [source];
  let cur = source;
  for (const e of edges) {
    cur = other(e, cur);
    nodes.push(cur);
  }
  return nodes;
}

const pathWeight = (edges: GraphEdge[]): number => edges.reduce((s, e) => s + e.weight, 0);
const pathSig = (edges: GraphEdge[]): string => edges.map(edgeKey).join('>');

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

/** A hop multiplies the anchor's rows when it isn't strictly one-to-one. */
const clauseMultiplies = (cardinality: GraphEdge['cardinality']): boolean => cardinality !== 'one-to-one';

function toClause(e: GraphEdge, from: string): JoinClause {
  return {
    joinTable: other(e, from),
    on: onPairs(e, from),
    cardinality: e.cardinality,
    confidence: e.confidence,
    provenance: e.provenance,
    multiplies: clauseMultiplies(e.cardinality),
  };
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
      clauses.push(toClause(e, node));
    }
  }

  return { anchorTable: anchor, clauses, unreachable };
}

const withFlags = (p: PartialPath, lowConfidence: boolean): JoinPath => ({
  ...p,
  lowConfidence,
  fanOut: p.clauses.some((c) => c.multiplies),
});

/**
 * Resolve the JOIN path connecting `tables`, tiered by trust: first over the
 * *trusted* graph (edges ≥ `minConfidence`), and only if that leaves tables
 * unreachable does it fall back to the full graph (incl. low-confidence
 * discovered edges) — flagging the result `lowConfidence`. Each clause carries its
 * own confidence/provenance so callers can see exactly how much to trust each hop.
 */
export function resolveJoinPath(adj: JoinGraph, tables: string[], opts: ResolveOptions = {}): JoinPath {
  const terminals = [...new Set(tables)];
  if (terminals.length === 0) return { anchorTable: '', clauses: [], unreachable: [], lowConfidence: false, fanOut: false };
  if (terminals.length === 1) return { anchorTable: terminals[0] as string, clauses: [], unreachable: [], lowConfidence: false, fanOut: false };

  const minConfidence = opts.minConfidence ?? TRUST_FLOOR;
  const allowFallback = opts.allowLowConfidenceFallback ?? true;

  const primary = resolveOnGraph(filterGraph(adj, minConfidence), terminals, opts);
  if (primary.unreachable.length === 0 || !allowFallback) {
    return withFlags(primary, false);
  }

  // Fallback: the trusted graph couldn't connect everything — use the full graph.
  const full = resolveOnGraph(adj, terminals, opts);
  if (full.unreachable.length < primary.unreachable.length) {
    const usedLowConfidence = full.clauses.some((c) => c.confidence < minConfidence);
    return withFlags(full, usedLowConfidence);
  }
  return withFlags(primary, false);
}

// ---------------------------------------------------------------------------
// K-best paths (Yen's algorithm) → scored candidates for an LLM to choose from.
// ---------------------------------------------------------------------------

export interface AllPathsOptions extends ResolveOptions {
  /** How many candidates to return (default 5). */
  k?: number;
}

/** Yen's K loopless shortest paths between two nodes, weight-ordered. */
export function kShortestPaths(adj: JoinGraph, source: string, target: string, k: number): GraphEdge[][] {
  const first = shortestPath(adj, source, target);
  if (first === null) return [];
  const A: GraphEdge[][] = [first];
  const B: Array<{ path: GraphEdge[]; weight: number }> = [];
  const seen = new Set<string>([pathSig(first)]);

  for (let kk = 1; kk < k; kk += 1) {
    const prev = A[kk - 1] as GraphEdge[];
    const prevNodes = nodesOf(source, prev);
    for (let i = 0; i < prevNodes.length - 1; i += 1) {
      const spurNode = prevNodes[i] as string;
      const rootPath = prev.slice(0, i);
      const blockedEdges = new Set<string>();
      for (const p of A) {
        if (p.length > i && pathSig(p.slice(0, i)) === pathSig(rootPath)) {
          blockedEdges.add(edgeKey(p[i] as GraphEdge));
        }
      }
      const blockedNodes = new Set<string>(prevNodes.slice(0, i)); // keep rootPath loopless
      const spur = shortestPath(adj, spurNode, target, blockedEdges, blockedNodes);
      if (!spur) continue;
      const total = [...rootPath, ...spur];
      const sig = pathSig(total);
      if (seen.has(sig)) continue;
      if (B.some((bb) => pathSig(bb.path) === sig)) continue;
      B.push({ path: total, weight: pathWeight(total) });
    }
    if (B.length === 0) break;
    B.sort((x, y) => x.weight - y.weight);
    const next = B.shift() as { path: GraphEdge[] };
    A.push(next.path);
    seen.add(pathSig(next.path));
  }
  return A;
}

function buildCandidate(
  source: string,
  target: string,
  edges: GraphEdge[],
  opts: AllPathsOptions,
): JoinPathCandidate {
  const minConfidence = opts.minConfidence ?? TRUST_FLOOR;
  // Anchor: a fact table among the two if provided, else the source.
  const anchor = opts.factTables?.includes(target) && !opts.factTables.includes(source) ? target : source;
  // Order clauses by walking the chain from the anchor.
  const remaining = [...edges];
  const clauses: JoinClause[] = [];
  let cur = anchor;
  while (remaining.length > 0) {
    const idx = remaining.findIndex((e) => e.a === cur || e.b === cur);
    if (idx === -1) break;
    const e = remaining.splice(idx, 1)[0] as GraphEdge;
    clauses.push(toClause(e, cur));
    cur = other(e, cur);
  }
  const fanOut = clauses.some((c) => c.multiplies);
  const usesLowConfidence = edges.some((e) => e.confidence < minConfidence);
  const totalConfidence = edges.reduce((p, e) => p * e.confidence, 1);
  const hops = edges.length;
  const provenanceMix = [...new Set(edges.map((e) => e.provenance))];
  // Rank by the same metric as the single-best resolver (total 1/confidence² weight,
  // lower = better) so the default order matches `resolveJoinPath`; fanOut / confidence
  // / provenance are exposed as signals the LLM can reorder on. Higher score = better.
  const score = 1 / (1 + pathWeight(edges));
  const path: JoinPath = { anchorTable: anchor, clauses, unreachable: [], lowConfidence: usesLowConfidence, fanOut };
  return { path, score, totalConfidence, hops, fanOut, usesLowConfidence, provenanceMix };
}

/**
 * Enumerate the K-best join paths between exactly two tables as scored candidates —
 * the payload a downstream LLM ranks to pick the right join for a question. Prunes
 * by hop-count (≤ shortest+2) and drops low-confidence routes when a clean one exists.
 */
export function resolveAllPaths(adj: JoinGraph, tables: string[], opts: AllPathsOptions = {}): JoinPathCandidate[] {
  const terminals = [...new Set(tables)];
  if (terminals.length !== 2) return [];
  const [a, b] = terminals as [string, string];
  const k = opts.k ?? 5;

  const raw = kShortestPaths(adj, a, b, k * 3); // over-fetch, then prune
  if (raw.length === 0) return [];

  let cands = raw.map((edges) => buildCandidate(a, b, edges, opts));
  const bestHops = Math.min(...cands.map((c) => c.hops));
  cands = cands.filter((c) => c.hops <= bestHops + 2); // hop cap
  if (cands.some((c) => !c.usesLowConfidence)) cands = cands.filter((c) => !c.usesLowConfidence);
  cands.sort((x, y) => y.score - x.score);
  return cands.slice(0, k);
}
