/**
 * Stage 1.6 — FK-symmetric grain-competitor sibling survival (between the S1.5 prune and S2 Steiner
 * routing). The retrieval layer Move 1 (ADR-013) was waiting on.
 *
 * THE FINDING (docs/diagnosis/grain-retrieval-survival.md): the dominant grain failure is TABLE-DROP:S2
 * — the correct fact table is anchored but the S1.5 specificity prune (ADR-008) keeps an FK-symmetric
 * SIBLING instead. `constructorresults` ⟷ `constructorstandings` both declare a single FK → `constructors`
 * (identical shape), so the Steiner cost→cardinality tie-break (ADR-009) cannot separate them, and the
 * prune picks the survivor by anchor-provenance specificity, which is GRAIN-BLIND. 950 and 994 are mirror
 * images (each drops the other) — proof it is a coin-flip, not a principled choice.
 *
 * THE FRAMEWORK (entity-linking candidate-generation / ranking split): if the correct candidate is absent
 * from the set, no ranker can recover it. Move 1 (the menu grain tag) is the ranker; it is dormant because
 * the competing siblings never co-occur in the payload. So we fix RETRIEVAL first — keep BOTH siblings,
 * tagged by grain — and let the planner choose (Route A: surface grain via the ontology, do NOT bake a
 * deterministic grain tie-break into the prune).
 *
 * THE TRIGGER (narrow — computed from graph structure + anchored columns, no hardcoded names). Two
 * candidate terminals a, b are FK-symmetric grain-competitor siblings iff:
 *   1. DECLARED-FK symmetry: declNeighbours(a)\{b} == declNeighbours(b)\{a}, where declNeighbours uses
 *      only `provenance === 'declared'` edges. Declared-only is load-bearing: the profiled graph adds
 *      DISCOVERED/INFERRED fact-to-fact edges (e.g. constructorresults↔constructorstandings via
 *      constructorid;raceid) that are asymmetric and would defeat the symmetry test.
 *   2. a shared anchored NON-KEY same-name column (both anchored `points`); join keys (PK ∪ any FK
 *      columnPair column) are excluded — they are anchored but are not grain competitors.
 *   3. at least one of a, b survived the prune (the narrowing gate): we only un-break a coin-flip among a
 *      group the prune already admitted; we never re-introduce a group the prune fully rejected (that
 *      would re-open the over-join the prune just fixed).
 * Members of every firing component (size ≥2, ≥1 kept) are retained, so the menu surfaces both siblings
 * side-by-side and Move 1's grain tag finally has something to choose between.
 *
 * Pure, deterministic function over the graph + sets: no LLM, no DB. Composes with back-prune (ADR-012):
 * the planner references one sibling; the unreferenced one is an FK-symmetric degree-1 leaf, so back-prune
 * drops it from FROM — keeping both never re-introduces an over-join.
 *
 * See docs/query/pruning.md, docs/query/subgraph.md and docs/adr/014-sibling-survival.md.
 */
import type { OntologyGraph } from './graph-model.js';

/** A firing FK-symmetric grain-competitor component (the certificate of why members were retained). */
export interface SiblingGroup {
  /** Class IRIs in the component (sorted). */
  members: string[];
  /** Declared neighbour signature shared by the component (sorted table IRIs). */
  signature: string[];
  /** The shared anchored non-key column name(s) that made them grain competitors (sorted). */
  sharedColumns: string[];
}

export interface SiblingSurvivalTrace {
  /** Components that fired (each retained all its members). Empty ⇒ no-op (non-regression). */
  groups: SiblingGroup[];
  /** Class IRIs added back to the terminal set beyond the prune's `kept` (sorted). */
  rescued: string[];
}

export interface RescueInput {
  /** The recall-favoring candidate terminals (AnchorSet.terminals). */
  candidates: string[];
  /** The prune survivors (pruneTerminals output). */
  kept: string[];
  /** Anchored columns per class IRI (deriveAnchoredColumns over the FULL AnchorSet). */
  anchoredColumns: Map<string, string[]>;
  graph: OntologyGraph;
}

export interface RescueResult {
  /** `kept` (original order) followed by rescued members not already kept (sorted). */
  terminals: string[];
  trace: SiblingSurvivalTrace;
}

/** Neighbour class IRIs reachable from `iri` via a DECLARED FK edge (artifacts excluded). */
function declaredNeighbours(graph: OntologyGraph, iri: string): Set<string> {
  const out = new Set<string>();
  for (const e of graph.adjacency.get(iri) ?? []) {
    if (e.provenance === 'declared') out.add(e.to);
  }
  return out;
}

/** Join-key columns of `iri`: primary keys ∪ every column that participates in an FK edge. */
function joinKeyColumns(graph: OntologyGraph, iri: string): Set<string> {
  const keys = new Set<string>();
  const node = graph.nodes.get(iri);
  for (const p of node?.properties ?? []) if (p.isPrimaryKey) keys.add(p.col);
  for (const e of graph.adjacency.get(iri) ?? []) for (const cp of e.columnPairs) keys.add(cp.fromCol);
  return keys;
}

/** Anchored, non-key columns that physically exist on `iri`'s node — the grain-competitor candidates. */
function grainColumns(input: RescueInput, iri: string): Set<string> {
  const { graph, anchoredColumns } = input;
  const node = graph.nodes.get(iri);
  const keys = joinKeyColumns(graph, iri);
  const out = new Set<string>();
  for (const col of anchoredColumns.get(iri) ?? []) {
    if (keys.has(col)) continue;
    if (!node?.properties.some((p) => p.col === col)) continue;
    out.add(col);
  }
  return out;
}

/**
 * Two class IRIs are FK-symmetric grain-competitor siblings: declared-neighbour signatures equal after
 * removing each other (a declared fact↔fact FK must not defeat symmetry). Exported so the tier-1 grain
 * resolver (ADR-016) restricts grain rebinds to the SAME structural sibling set this module surfaces —
 * never swapping the entity (e.g. driverstandings↦constructorresults).
 */
export function fkSymmetric(graph: OntologyGraph, a: string, b: string): boolean {
  const na = declaredNeighbours(graph, a);
  const nb = declaredNeighbours(graph, b);
  na.delete(b);
  nb.delete(a);
  if (na.size !== nb.size) return false;
  for (const x of na) if (!nb.has(x)) return false;
  return true;
}

// ---- Union-find over candidate class IRIs (components of the sibling relation) ----
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
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Retain FK-symmetric grain-competitor siblings the prune dropped by grain-blind specificity, so both
 * survive into the payload (and Move 1's grain tag can choose). Returns `kept` widened by the rescued
 * members; a no-op (identical terminal set) when the trigger does not fire.
 */
export function rescueFkSymmetricSiblings(input: RescueInput): RescueResult {
  const { candidates, kept, graph } = input;
  const keptSet = new Set(kept);

  // Precompute grain columns once per candidate.
  const grainByCand = new Map<string, Set<string>>();
  for (const c of candidates) grainByCand.set(c, grainColumns(input, c));

  // Build the sibling relation: a~b iff FK-symmetric AND they share ≥1 non-key anchored column.
  const uf = new UnionFind();
  const sharedByPair = new Map<string, string[]>(); // "a|b" (sorted) -> shared columns
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (!fkSymmetric(graph, a, b)) continue;
      const ga = grainByCand.get(a)!;
      const gb = grainByCand.get(b)!;
      const shared = [...ga].filter((col) => gb.has(col)).sort();
      if (shared.length === 0) continue;
      uf.union(a, b);
      sharedByPair.set([a, b].sort().join('|'), shared);
    }
  }

  // Collect components (size ≥2) that pass the narrowing gate (≥1 member kept), retain their members.
  const componentMembers = new Map<string, string[]>();
  for (const c of candidates) {
    const root = uf.find(c);
    (componentMembers.get(root) ?? componentMembers.set(root, []).get(root)!).push(c);
  }

  const groups: SiblingGroup[] = [];
  const rescuedSet = new Set<string>();
  for (const members of componentMembers.values()) {
    if (members.length < 2) continue;
    if (!members.some((m) => keptSet.has(m))) continue; // gate 3
    const sortedMembers = [...members].sort();
    const sharedColumns = new Set<string>();
    for (let i = 0; i < sortedMembers.length; i++) {
      for (let j = i + 1; j < sortedMembers.length; j++) {
        const cols = sharedByPair.get([sortedMembers[i]!, sortedMembers[j]!].sort().join('|'));
        for (const col of cols ?? []) sharedColumns.add(col);
      }
    }
    const sig = declaredNeighbours(graph, sortedMembers[0]!);
    for (const m of sortedMembers) sig.delete(m);
    groups.push({
      members: sortedMembers,
      signature: [...sig].sort(),
      sharedColumns: [...sharedColumns].sort(),
    });
    for (const m of sortedMembers) if (!keptSet.has(m)) rescuedSet.add(m);
  }

  const rescued = [...rescuedSet].sort();
  return {
    terminals: [...kept, ...rescued],
    trace: { groups: groups.sort((x, y) => (x.members[0]! < y.members[0]! ? -1 : 1)), rescued },
  };
}
