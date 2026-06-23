# Stage 2 — Subgraph extraction (the deterministic router)

Stage 2 sits between anchoring (Stage 1) and the LLM planner (Stage 3). Given a set of
**terminal** classes (tables Stage 1 anchored the question to), it deterministically chooses
which tables connect and **how** they join, and emits a trimmed `SubgraphPayload`. The LLM never
picks a join: *the LLM chooses, the graph constrains, the compiler writes.* No LLM, no DB here.

Files: [`src/query/graph-model.ts`](../../src/query/graph-model.ts) (types),
[`src/query/graph-build.ts`](../../src/query/graph-build.ts) (JSON-LD → graph),
[`src/query/subgraph.ts`](../../src/query/subgraph.ts) (Steiner core + payload).

## Input: the qsl ontology JSON-LD
Three top-level regions exist; Stage 2 reads **only the asserted `@graph`**:
- `@graph` — `owl:Class` (one per table), `owl:DatatypeProperty` (columns), `owl:ObjectProperty`
  (relationships), `qsl:Capability` (metrics/dimensions/factTables/timeGrains).
- `qsl:candidateGraph` — low-confidence `qsl:CandidateRelationship` noise. **Never iterated.**
  `buildGraph` parses through `OntologyJsonLdSchema`, which keeps only `@context` + `@graph`, so
  the candidate region is structurally dropped. (Contrast `loadFullGraph` in `ontology-index.ts`,
  which deliberately *merges* candidates back for schema-linking — the opposite need.)
- `qsl:ontology` — header (fingerprint, build, resolved knobs). Ignored by routing.

## The weight function (RULE C — the H1 knob)
```
weight(edge) = uniform ? 1 : max(1 − confidence, tierFloor[provenance])
tierFloor = { declared: 0, discovered: QUERY_EDGE_FLOOR_DISCOVERED, 'inferred-name': QUERY_EDGE_FLOOR_NAME }
```
A higher-confidence edge is cheaper to traverse, so the router prefers trustworthy joins. The
provenance floor keeps even a "confidence 1.0" *discovered* or *name-matched* edge from looking as
free as a *declared* foreign key.

### Env knobs (resolved once per build; defaults in parentheses)
| Env var | Default | Meaning |
|---|---|---|
| `QUERY_EXPORT_MIN_CONF` | `0.5` | Edges below this confidence are dropped from routing entirely. |
| `QUERY_EDGE_FLOOR_DISCOVERED` | `0.02` | Floor weight for `discovered` edges. |
| `QUERY_EDGE_FLOOR_NAME` | `0.30` | Floor weight for `inferred-name` edges. |

`uniform: true` (an `ExtractOpts`/`BuildOpts` flag, also the H1 experimental arm) forces every
weight to 1, turning the router into a pure hop-count minimiser. See
[the H1 experiment note](../experiments/h1-join-routing.md) for why this matters.

## Algorithm: metric-closure + MST (Steiner 2-approximation)
1. `terminals.length ≤ 1` → trivial single-node payload, no routing.
2. Dijkstra (cost = `edge.weight`) from each terminal → shortest path between every terminal pair.
3. Any pair unreachable → `disconnected: true`, return the best partial **forest** (never throws).
4. Complete graph on terminals (meta-edge = shortest-path distance); **Kruskal MST**, meta-edges
   ordered by **cost, then edge count (fewer hops), then lexicographic** (see the objective below).
5. Expand MST meta-edges back to real `JoinEdge`s, union, take an MST of the union to remove
   incidental cycles, then prune degree-1 non-terminal leaves → a tree.
6. `bridgeNodes` = tree nodes that are not terminals.
7. `totalCost` = Σ tree edge weights. `aggregateConfidence` = **MIN** tree-edge confidence
   (weakest-link: a tree is only as trustworthy as its least-trusted join).

A composite join costs its single edge `weight` when traversed (not per-column) — it is one edge
(RULE B), so this falls out naturally.

**Exact vs approximate.** Metric-closure + MST is the classic 2-approximation of the Steiner tree
(NP-hard in general). For ≤ 2 terminals the MST *is* the exact optimum (it reduces to a single
shortest path). For more terminals the result is within 2× of optimal; that is acceptable here
because the ontology graph is tiny (tens of nodes) and the payload is consumed by an LLM, not a
cost-sensitive optimiser. `k`-best alternative trees (Yen's k-shortest) are reserved — `k > 1`
throws today.

### Objective: minimum-cost, then minimum-cardinality, then lexicographic
The routing objective is a **lexicographic tuple**:

1. **minimum total edge cost** — primary; confidence/provenance weights (RULE C) win first.
2. **minimum edge count** (fewer joins) — secondary; consulted only on an exact cost tie. Node
   count is *omitted* as a key because for a tree `nodes = edges + 1`, so edge count subsumes it.
3. the existing per-path tie-break (below) for full determinism.

Cost stays strictly primary: a cheaper tree with more edges still beats a costlier tree with fewer
edges — a low-confidence shortcut is never preferred for being shorter. Only ties on cost fall
through to cardinality.

**Why this is needed (the zero-cost spanning-subgraph property).** On a fully-declared schema the
declared FKs form a *zero-cost* connected subgraph, so cost alone cannot discriminate among valid
trees — the tie-break decides the topology. Min-cardinality makes that choice principled: e.g. the
pruned terminals `{drivers, qualifying, races}` route the 2-edge `qualifying→drivers +
qualifying→races` tree instead of the cost-equal 3-edge tree that needlessly hubbed through
`laptimes`. This is the 4th manifestation of the property (see the [H1 note](../experiments/h1-join-routing.md)).

The cardinality key lives at exactly **one** point — the metric-closure meta-edge ordering
(`metaLess`) — because that selection fixes the tree's node set; the final spanning tree then has
`nodes − 1` edges regardless, so there is no further cardinality freedom downstream.

### Per-path tie-break (determinism; part of RULE C)
Within a single shortest path, among **equal-cost** paths a fixed order applies:
1. higher min-confidence along the path, then
2. fewer hops, then
3. fewer composite edges, then
4. the lexicographically smaller ordered list of source IRIs.

This matters on intact schemas where many declared routes tie at cost 0 (see the H1 note).

## Output: `SubgraphPayload` (the Stage-3 contract)
```ts
{
  classes:   { iri, properties: ColumnProp[] }[],     // trimmed (see below)
  joins:     { from, to, on: [fromCol,toCol][], provenance, confidence }[],  // canonical domain→range
  capabilities: { iri, kind, scopeClass, scopeProperty?, prefLabel? }[],     // scoped to a tree node
  aggregateConfidence: number,   // MIN tree-edge confidence (1 if no edges)
  bridgeNodes: string[],         // Steiner points the compiler must pass through
  totalCost:  number,            // Σ tree-edge weights (0 if no edges)
  disconnected?: boolean,        // set when a terminal pair was unreachable
}
```

### Property trimming (GPT-5-mini context discipline)
For each class in the tree, keep **only**:
- (a) every column used in a join in this tree,
- (b) every anchored column (from `opts.anchoredColumns`),
- (c) for **terminal** classes only, enum columns' `sampleValues`, truncated to 15.

Everything else is dropped. Example: `results` has ~18 columns; if it is on the tree it carries its
join keys (e.g. `driverid`, `constructorid`) and not `fastestlapspeed`/`positiontext`/etc.
