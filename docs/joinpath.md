# How `joinpath` Is Built — The Join Resolver

`joinpath` answers one question deterministically: **given a set of tables, what are the exact
`JOIN` clauses that connect them?** It turns "which JOINs?" from an LLM guess into a graph search
over the relationships the ontology discovered. This document walks the build from the ground up,
the design choices and the **problems we actually hit** at each step (pros/cons), and the
limitations still ahead.

It is the query-side companion to [ontology-build.md](ontology-build.md) (which covers how the
relationships themselves are discovered).

---

## 1. What it does

```
input : a generated ontology (.jsonld) + a list of table names
output: FROM <anchor> + a chain of JOIN <t> ON <cols> clauses, each tagged with
        cardinality / provenance / confidence, plus fan-out and low-confidence flags
```

It is **pure, deterministic, zero-dependency** — no LLM, no embedding model, no DB. Everything is
classical graph theory over the foreign-key graph stored in the ontology.

Entry point: [`src/cli/joinpath.ts`](../src/cli/joinpath.ts) → `pnpm run joinpath`.

---

## 2. The pipeline

```
ontology .jsonld
   │  ① load            src/query/ontology-index.ts   buildOntologyIndex()
   ▼
OntologyIndex { classes, columnsByTable, capabilities, joinEdges }
   │  ② build graph     src/query/join-graph.ts        buildJoinGraph()
   ▼
JoinGraph (undirected, weighted adjacency) + synthesized co-reference edges
   │  ③ resolve         src/query/join-graph.ts        resolveJoinPath() / resolveAllPaths()
   ▼
JoinPath (single best)  or  JoinPathCandidate[] (K-best for an LLM)
   │  ④ render          src/cli/joinpath.ts
   ▼
SQL JOIN skeleton  or  JSON candidate list
```

- **① Loader** reads the JSON-LD `@graph`, turning every unary `owl:ObjectProperty` (which carries
  `qsl:joinFromColumn` / `qsl:joinToColumn`) into a `JoinEdge`. N:M aggregates (no literal keys) are
  skipped — the junction class is already connected by its two unary edges.
- **② Graph build** makes an undirected weighted graph and **synthesizes co-reference edges** (see
  §5.4).
- **③ Resolve** runs the graph algorithms below.
- **④ Render** prints the JOIN skeleton, or the K-best JSON when `--paths` is given.

---

## 3. The graph model

- **Nodes** = tables.
- **Edges** = foreign-key relationships. Each carries its literal key pairs (`on`), a `cardinality`,
  a `provenance` (`declared` | `discovered` | `inferred-name` | `co-reference`) and a `confidence`.
- **Edge weight = `1 / confidence²`.** This is the single most important tuning choice — declared
  FKs (confidence 1 → weight 1) decisively beat coincidences (0.05 → weight 400), so the *shortest*
  path is also the *most trustworthy* one.
- **Multi-column edges.** An edge's `on` is a **list** of equalities — length 1 for an ordinary FK,
  ≥2 for a composite/co-reference join (`raceid AND driverid`).

---

## 4. The algorithms (and why each)

| Algorithm | Role | Why this one |
|---|---|---|
| **Dijkstra** | shortest weighted path between two tables | weights matter, so not plain BFS |
| **Steiner tree (KMB 2-approx)** | connect 3+ tables minimally | exact Steiner is NP-hard; 2-approx is the standard |
| **Prim's MST** | the middle step of the Steiner 2-approx (over the terminals' metric closure) | classic KMB construction |
| **BFS** | order the chosen JOIN clauses from the anchor | each JOIN must attach to an already-joined table (valid SQL order) — ordering, not pathfinding |
| **Yen's K-shortest paths** | enumerate alternative routes for the LLM | loopless, weight-ordered, builds directly on Dijkstra |

This is the same family the SOTA Text-to-SQL systems use (SchemaGraphSQL = Dijkstra, SteinerSQL =
KMB Steiner 2-approx). All hand-rolled in ~500 lines, zero graph-library deps.

---

## 5. How it evolved — the steps, with pros & cons

### 5.1 v0 — single shortest path, weight `1/confidence`
First cut: Dijkstra/Steiner with edge weight `1/confidence`.

- **Pro:** deterministic JOINs straight from the discovered FK graph.
- **Con / bug we hit:** on ecommerce a coincidental 1-hop edge (`line_items.quantity → customers.id`,
  weight ~2) **tied** a legitimate 2-hop declared path (weight 1+1 = 2), and the tie broke the wrong
  way → `JOIN customers ON line_items.quantity = customers.id`. Wrong join, silently.

### 5.2 v1 — weight `1/confidence²` (square it)
Squaring the penalty separated the tiers: a 0.5 coincidence jumps to weight 4, which can no longer
beat a 2-hop all-declared path (weight 2), while a real 0.78 discovered FK (~1.6) stays cheap.

- **Pro:** coincidences can't sneak in as shortcuts; the ranking became robust.
- **Con:** the exact exponent is a heuristic — it works for our confidence bands but isn't derived
  from a probabilistic model.

### 5.3 v2 — confidence tiering (keep-all + trusted-first)
Generation keeps *every* edge (incl. 0.05 surrogate noise); the resolver searches a **trusted
subgraph** (confidence ≥ 0.5) first and only falls back to the full graph for otherwise-unreachable
tables, flagging the result `lowConfidence`.

- **Pro:** noise is *stored but ignored* for normal queries, yet *available* for hard requests; the
  fallback is explicit, never silent.
- **Con:** the ontology file carries a lot of dead 0.05 edges (bloat). Cosmetic, not a correctness
  issue — a `--prune` pass is the deferred fix.

### 5.4 Sprint 0a — co-reference edges (composite joins)
**The grain bug.** `joinpath qualifying,results` joined through `constructors` on `constructorid`
alone — matching every Ferrari qualifying lap to every Ferrari result across all races/drivers.
Those tables have **no FK between them**; they are sibling fact tables sharing the same dimension
keys. So we **synthesize** a direct edge: any two tables sharing **≥2 FK parents** get a
co-reference edge joining on all the shared keys (`raceid AND driverid AND constructorid`).
(`synthesizeCoReferenceEdges`, confidence 0.75, tuned so a 1-hop co-ref `weight 1.78` beats a 2-hop
dimension detour `weight 2.0`.)

- **Pro:** the correct-grain join is now produced and preferred; required no ontology change (it's
  synthesized at load).
- **Cons / bugs we hit:**
  - **Explosion risk** — connecting *every* pair sharing *any* dimension would densely connect the
    graph. Bounded by the **≥2 shared-parents** rule (1 shared parent = the fan-trap route, left
    out) → ~a dozen edges on f1.
  - **Noise edge blocked synthesis** — a 0.00-confidence coincidence (`qualifying.qualifyid →
    results.resultid`) made the "already directly joinable?" guard skip the real co-reference. Fixed:
    only **trusted** direct edges count as already-joinable.

### 5.5 Sprint 0b — fan-out flag
Correct JOINs still double-count under aggregation: `SUM(points)` over `drivers→results→pitstops`
inflates by the number of pit stops. Each clause now sets `multiplies` (cardinality not 1:1) and the
path sets `fanOut`, surfaced as `[fan-out]` in the CLI.

- **Pro:** the silent-double-count risk is now visible; consumes the cardinality the graph already
  knew — no new traversal.
- **Con:** intentionally **conservative** — it flags any `one-to-many`/`many-to-many` hop, even when a
  later `GROUP BY` would make the aggregate correct. It advises, it doesn't decide.

### 5.6 Sprint 0c — K-best paths for the LLM (`--paths`)
A single answer hides genuine ambiguity (qualifying↔results has ~4 plausible routes). **Yen's
K-shortest** (`kShortestPaths` → `resolveAllPaths`) returns the top-K routes as scored
`JoinPathCandidate`s — each with `score`, `totalConfidence`, `hops`, `fanOut`, `usesLowConfidence`,
`provenanceMix` — ranked by the same weight metric as the single best, pruned by a confidence floor
and a hop cap (≤ shortest+2). This is the payload a later LLM stage ranks to pick the
semantically-right join.

- **Pro:** keeps the deterministic core deterministic while handing the *decision* to the LLM with
  full evidence; the composite route ranks first by default.
- **Cons:** **2-table only** (N-terminal tree alternatives are much harder, deferred); the default
  ranking is a fixed weight heuristic the LLM must be trusted to override when the question demands a
  different grain.

---

## 6. Current capabilities

- Single best path: `pnpm run joinpath --ontology <f> --tables a,b,c`
- K-best candidates (2 tables): `--paths K` → JSON for the LLM
- Probe the discovered tier: `--min-confidence <x>`
- Per-hop tags: cardinality, provenance, confidence, `[fan-out]`; path-level `[⚠]` low-confidence
  and `[fan-out]` banners.

---

## 7. Limitations & what we'll likely face later

| Area | Limitation today | Likely fix / risk |
|---|---|---|
| **Declared composite FKs** | a real multi-column FK constraint is flattened to single-column edges (only *shared-dimension* co-references are reconstructed) | group declared FKs by constraint `name` into one multi-col edge |
| **N-table K-paths** | `--paths` is pairwise only | enumerate alternative Steiner trees (edge-penalty diversification) — combinatorially harder |
| **Semantic joins** | lexical/structural only — a non-lexical relationship the data doesn't verify is invisible | embedding similarity (à la SteinerSQL `τ=0.75`) — adds a model dependency & breaks determinism |
| **Confidence/score calibration** | `1/confidence²`, the 0.75 co-ref value, and the rank score are **heuristics**, not probabilities | could mis-rank in edge cases; would need labelled data to calibrate |
| **Fan-out precision** | over-flags (any 1:N hop), no `GROUP BY` awareness | a grain-aware pass once the SQL generator exists |
| **Anchor (FROM) choice** | highest-degree / fact-table heuristic | may not match query intent; the LLM/generator may need to override |
| **Scaling** | Dijkstra is naïve `O(V²)` (no heap); Yen's re-runs it K·L times | fine at ~10–30 tables; a binary-heap Dijkstra needed for hundreds-of-tables (BIRD-scale) schemas |
| **Noise bloat** | 0.05 edges stored in the ontology | optional load-time prune (Sprint 0d, off by default) |

---

## 8. Usage

```bash
F=$(ls -t out/ontology-*.jsonld | head -1)

pnpm run joinpath --ontology "$F" --tables qualifying,results          # single best (composite)
pnpm run joinpath --ontology "$F" --tables qualifying,results --paths 5 # K-best JSON for the LLM
pnpm run joinpath --ontology "$F" --tables driverstandings,races        # simple direct join
```

No regeneration is needed to pick up resolver changes — co-reference edges, fan-out flags and
K-paths are all computed at **load time** from the existing ontology's edges.

---

## Reference

Algorithms: Dijkstra (1959); Kou–Markowsky–Berman Steiner 2-approximation (1981); Yen's K-shortest
loopless paths (1971). Schema-linking framing: SchemaGraphSQL (arXiv 2505.18363), SteinerSQL (arXiv
2509.19623).
