# How the Ontology Is Built — End to End

This document explains how the agent turns a bare PostgreSQL database into an OWL+SKOS
ontology (emitted as JSON-LD and Turtle): the full pipeline from scratch, how **data
profiling** recovers the structure the catalog never declared, how **column naming** is now
fused with profiling as a peer evidence source, and **how strong** the result is — what it
catches, what it misses, and why.

It complements the per-step docs ([single-column](single-column-profiling.md),
[key-discovery](key-discovery.md), [candidate-pairs](candidate-pairs.md)) by tying the whole
run together.

---

## 1. What is being built

The ontology is a **semantic layer** over the relational schema:

- **Classes** — one per table (`owl:Class`), with SKOS labels/synonyms/definitions.
- **Datatype properties** — one per column, mapped back to `table.column`.
- **Object properties** — the **relationships** (foreign keys), each carrying its literal
  join columns, a `cardinality`, a `provenance`, and a `confidence` in `[0,1]`.
- **Capabilities** — metric/aggregation hints (e.g. fact tables, measures) for downstream
  query generation.

The object properties are the heart of the system: they are what lets a downstream resolver
compile `JOIN` paths deterministically instead of guessing. Getting them **complete** (recall)
and **correct** (precision) is the whole game, and is where profiling + naming come in.

---

## 2. The pipeline (LangGraph, 6 nodes)

Defined in [`src/agent/graph.ts`](../src/agent/graph.ts). Five "logical" SPARC-style nodes
plus the deterministic profiling node, in sequence, with one bounded retry edge:

```
START
  │
  ▼
① schema-ingest ──────────► canonical schema (tables, columns, declared FKs)   [DB, no LLM]
  │
  ▼
①b relationship-discover ─► ForeignKeyCandidate[]  (the 4 profiling steps)      [DB, no LLM]
  │
  ▼
② concept-extract ────────► classes + datatype props with SKOS labels          [LLM]
  │
  ▼
③ relationship-link ──────► merge declared FKs + discovered candidates          [no LLM]
  │                           → object properties (provenance, confidence, joinColumns)
  ▼
④ capability-infer ───────► capabilities (fact tables, measures, formula hints) [LLM]
  │
  ▼
⑤ validate ───────────────► structural/zod checks ── errors? ──► retry ② (≤2)   [no LLM]
  │                                                  └─ clean ──► END
  ▼
assemble + serialize ─────► JSON-LD `@graph` + Turtle
```

Key design points:

- **Only nodes ② and ④ use an LLM** (concept naming and capability inference). Everything that
  touches **relationships and joins is 100% deterministic** — no LLM, no embedding model.
- **Profiling (①b) runs once**, before the retry loop, because the DB work is the most
  expensive part and is fully reproducible. It reuses the profiling modules verbatim
  ([`01b-relationship-discover.ts`](../src/agent/nodes/01b-relationship-discover.ts)).
- The DB connection is **read-only**, `public` schema only.

---

## 3. From scratch: schema ingest

[`01-schema-ingest.ts`](../src/agent/nodes/01-schema-ingest.ts) reads `information_schema`
into a `CanonicalSchema`: tables, columns (name + type), and the **declared** foreign-key
constraints. This is everything the database *was told about itself* — and on real-world
dumps it is often radically incomplete (constraints dropped for load speed, ETL targets with
no FKs, legacy schemas). The catalog is the floor, not the ceiling.

---

## 4. Profiling: recovering what the catalog never declared (node ①b)

Grounded in Abedjan, Golab & Naumann, *Profiling relational data: a survey* (VLDB J. 2015).
Four steps run in order; the first three are detailed in their own docs, summarized here.

### Step 1 — single-column profiling → [`single-column.ts`](../src/profiling/single-column.ts)
One batched SQL pass per table computes, per column: `dataType`, `numRows`, `nullCount`,
`distinctCount`, `uniquenessRatio`, `min`, `max`. This is the cheap statistical substrate
everything else builds on.

### Step 2 — key discovery → [`key-discovery.ts`](../src/profiling/key-discovery.ts)
Identifies single-column (and bounded 2-column) **unique keys** — the only legal *target*
side of a foreign key (§5.3.5: "a FK's RHS is a key"). Cross-tags them against declared
`PRIMARY KEY` / `UNIQUE` constraints (`declared: 'primary' | 'unique' | null`).

### Step 3 — candidate pairs + prefilter → [`candidate-pairs.ts`](../src/profiling/candidate-pairs.ts)
Forms `(source column → target key)` pairs and cheaply discards the **provably impossible**
ones using only Step-1 stats — three *necessary conditions* for an inclusion dependency
`A ⊆ B`:

1. **type-compatible** (same type family),
2. `distinct(A) ≤ distinct(B)`,
3. `[min(A),max(A)] ⊆ [min(B),max(B)]`.

The expensive value scan then only runs on survivors. **(See §5 — naming now relaxes prunes
2 & 3.)**

### Step 4+5 — IND verification + FK promotion → [`foreign-keys.ts`](../src/profiling/foreign-keys.ts)
For each surviving pair, an actual containment scan measures the **containment ratio** (the
fraction of distinct source values found in the target). A pair is promoted to a foreign key
when the ratio clears `ONTOLOGY_IND_MIN_CONTAINMENT` (default **0.7** — an *approximate* IND, so
a few orphan rows in a trimmed dump don't lose a real FK).

Because "a FK must satisfy an IND, but **not all INDs are FKs**" (§5.3.5) — sequential
surrogate keys `1..N` form INDs with any small-integer column — each verified IND is **scored**
([`scoreForeignKey`](../src/profiling/foreign-keys.ts)):

```
score = 0.15 + 0.7 · nameSimilarity
        + 0.1   if the target key is referenced ≥2× (a popular RHS, more FK-like)
        − 0.3   if the source is its own table's surrogate key   (only when name is weak)
        − 0.2   if the target is a bare surrogate PK             (only when name is weak)
```

Name similarity **dominates** the score, with a low baseline — so a name-less coincidence
starts near zero and surrogate-key coincidences fall out, while a name-matching FK scores
~0.85–0.95.

---

## 5. Naming, now a peer to profiling

### The problem it fixes
Originally **naming was subordinate to profiling**: a pair had to pass the data-stat prefilter
**and** the IND gate before naming was even consulted (it only adjusted the score). On a
trimmed/partial dump, a real FK like `driverstandings.raceid → races.raceid` was dropped
*twice* before naming could vote:

1. the prefilter pruned it (`distinct(driverstandings.raceid) > distinct(races.raceid)` once
   `races` is trimmed), and
2. the IND gate dropped it (containment fell below threshold for the same reason).

The edge vanished entirely — neither declared nor discovered — so joins detoured through the
hub instead of going direct.

### The fix: union, not chain
Naming and profiling are now **independent evidence sources**, fused two ways
([`name-match.ts`](../src/profiling/name-match.ts)):

1. **Prefilter relaxation** ([candidate-pairs.ts](../src/profiling/candidate-pairs.ts)) — when
   a pair is a **strong name match**, the *data-stat* prunes (`distinct-exceeds`,
   `range-outside`) are skipped, so a trimmed-dump FK survives to be tested. The **hard**
   prunes still apply (same-column, empty source, **type incompatibility**) — a name match
   across incompatible types is not a joinable FK.

2. **Name-fallback at the IND gate** ([foreign-keys.ts](../src/profiling/foreign-keys.ts)) —
   when the IND falls short **but** the name strongly matches **and** the target column is a
   **declared primary key**, the edge is still promoted, tagged `evidence: 'name'`, at a
   capped confidence (`ONTOLOGY_NAME_ONLY_CONFIDENCE`, default **0.65**).

### How name similarity is computed
[`nameSimilarity(sourceColumn, targetTable)`](../src/profiling/name-match.ts) — **pure lexical
comparison, no embedding model.** It derives bases from both conventions:

- `X_id` → `X` (`customer_id` → `customer`, via `predicateFromColumn`)
- `Xid` → `X` (`raceid` → `race`, `statusid` → `status`)

and scores against the (singular/plural-normalized) target table name:

| Result | When |
|---|---|
| **1.0** | base equals the table (`raceid`→`races`, `constructorid`→`constructors`) |
| **0.7** | base is most of a compound table name, or the column embeds the singular |
| **0** | unrelated (`quantity`→`customers`, `id`→`orders`) |

The **default match bar is 1.0** (`ONTOLOGY_NAME_MATCH_MIN`) — only exact base==table matches
trigger relaxation/recovery, so we resurrect real FKs without flooding. Tunable down toward 0.7
for more recall.

### Provenance — three tiers
The evidence type flows into the object property's `provenance`
([03-relationship-link.ts](../src/agent/nodes/03-relationship-link.ts)):

| name+type | IND holds | confidence | `provenance` | example |
|---|---|---|---|---|
| strong | yes | ~0.9 | `declared` (if in catalog) / `discovered` | `results.raceid → races` |
| **strong** | no | **0.65** | **`inferred-name`** | `driverstandings.raceid → races` |
| weak | yes | ~0.05–0.25 | `discovered` | surrogate coincidence (kept, but ignored) |
| weak | no | — | (no edge) | |

Declared catalog FKs always win (`provenance: declared`, `confidence: 1`).

---

## 6. How strong is it?

### What it catches
- **All declared FKs** — authoritative, confidence 1.
- **Undeclared FKs whose data containment holds** — the classic profiling win (`discovered`,
  score from the signals above).
- **Real FKs lost to trimmed/dirty data** — recovered by naming when the column name matches
  the target table and the target is a primary key (`inferred-name`, 0.65). This is the recall
  fix that makes direct joins like `driverstandings.raceid = races.raceid` appear.
- **Self-references** (`manager_id → id`) and **N:M junctions** (a 2-column key whose parts are
  each FKs) → a single direct many-to-many object property.

### Precision guards (why it doesn't flood)
- **IND scoring** drives surrogate-key coincidences to ~0.05; the **query-time resolver tiers
  by confidence** (trusted ≥ 0.5 first, low-confidence only as a flagged fallback), so noise is
  stored but never auto-joined.
- **Name recovery is gated to declared primary-key targets** — without this, a name-matched
  source would recover against any coincidentally-unique column (e.g. `order_id →
  orders.total_amount` instead of `orders.id`). This bug was caught and fixed in testing.
- **Type incompatibility is never overridden** by a name match.
- **Approximate IND** (0.7) tolerates a few orphan rows without accepting unrelated columns.

### Honest limits
- **Lexical naming only — no embeddings.** It nails conventional names
  (`raceid`→`races`, `customer_id`→`customers`) but **misses semantic-but-not-lexical** FKs:
  `buyer_id → customers.id` (where "buyer" ≠ "customer") would be found only if the data
  containment holds, not by name. An embedding similarity (à la SteinerSQL's `τ=0.75` semantic
  edge) would close this, at the cost of a model dependency and determinism — deliberately not
  taken.
- **Name recovery needs a *declared* primary key** on the target. A dump with **no PK
  constraints at all** won't name-recover (the gate has nothing to match); declared PKs are
  near-universal, but this is the one schema shape where recall regresses.
- **Composite (multi-column) foreign keys** beyond the N:M junction case are out of scope.
- **Confidence numbers are heuristic**, not probabilities — they rank edges, they don't
  calibrate to a true likelihood.

### Net
On a clean schema with declared constraints (e.g. the ecommerce DB), the catalog already wins
and profiling/naming add **no noise** — exactly the no-op you want. On a stripped schema (e.g.
a trimmed formula1 dump with constraints removed), profiling recovers the data-verifiable FKs
and **naming recovers the rest**, so the relationship graph is complete enough for direct joins
where a catalog-only approach would leave holes.

---

## 7. Tuning knobs (env)

| Variable | Default | Effect |
|---|---|---|
| `ONTOLOGY_IND_MIN_CONTAINMENT` | `0.7` | Min containment ratio to accept an (approximate) IND |
| `ONTOLOGY_NAME_MATCH_MIN` | `1.0` | Min `nameSimilarity` to relax the prefilter / trigger name recovery |
| `ONTOLOGY_NAME_ONLY_CONFIDENCE` | `0.65` | Confidence assigned to an `inferred-name` edge |
| `ONTOLOGY_FK_MIN_SCORE` | `0` | Generation-time floor for keeping a discovered edge (0 = keep all; resolver tiers at query time) |

---

## 8. Inspecting the result

```bash
pnpm run generate --dsn "postgresql://user:pass@host:5432/db"   # build the ontology
# then resolve a JOIN path over the discovered graph:
F=$(ls -t out/ontology-*.jsonld | head -1)
pnpm run joinpath --ontology "$F" --tables tableA,tableB,tableC
```

Each emitted object property carries `qsl:provenance`, `qsl:confidence`, `qsl:joinFromColumn`,
`qsl:joinToColumn` — so the join graph is fully reconstructable from the ontology alone, with
the evidence for every edge visible.

---

## Reference

> **Z. Abedjan, L. Golab, F. Naumann.** *Profiling relational data: a survey.* The VLDB Journal
> **24**(4), 557–581 (2015). [10.1007/s00778-015-0389-y](https://doi.org/10.1007/s00778-015-0389-y)

Naming-as-evidence and the join-path / Steiner framing are informed by recent Text-to-SQL
schema-linking work (SchemaGraphSQL, SteinerSQL) — see the join-path resolver
([`src/query/join-graph.ts`](../src/query/join-graph.ts)) for the consuming side.
