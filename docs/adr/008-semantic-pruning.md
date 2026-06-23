# ADR-008 — Semantic pruning: drop unanchored terminals before Steiner

**Status:** Accepted · **Date:** 2026-06-23 · **Scope:** `src/query/prune.ts`,
`src/query/pipeline.ts`, `src/query/anchor-model.ts`, `src/query/anchor.ts` · **Relates:**
[ADR-005](005-anchoring.md), [ADR-002](002-subgraph-extraction.md), [ADR-006](006-pipeline-wiring.md)

## Context

The pipeline is `anchor (S1) → subgraph/Steiner (S2) → planner (S3a) → compiler (S3b) → execute`.
S1 is deliberately **recall-favoring** (ADR-005): it over-returns candidate `terminals` so it never
misses. S2's Steiner extraction then connects them at least cost. But intact F1 is fully connected
at low cost (the zero-cost spanning-subgraph property), so S2 weaves **all** recall-favoring
terminals into one tree. Diagnostic on "drivers eliminated in the first period in race number 20":
S1 handed S2 **8** terminals and S2 routed a **9-table / 8-join** tree, when the question needs only
`qualifying` + `drivers` (+ `races`). The extra tables were never grounded by anything the question
specifically pointed at — they entered as generic-shared-column matches (`name`, `id`, foreign keys)
that are present in nearly every table.

S1 must stay recall-favoring (too few terminals is unrecoverable). The fix is a separate reconciling
stage between grounding and routing.

## Decision — insert a grounding → PRUNING → reasoning stage, pruning by anchor provenance

Add `pruneTerminals(anchorSet)` (Stage 1.5), wired in `subgraphNode` before `extractSubgraph`. It is
a pure, deterministic function over the `AnchorSet` (no graph, no LLM, no DB). It removes terminals
from the **must-include set** only — never from the traversable graph.

**Precedent.** *PipeNet* ("Question Answering with Semantic Pruning over Knowledge Graphs", Su et
al.) establishes the **grounding → pruning → reasoning** paradigm: insert a pruning stage that scores
nodes by relatedness to the question and drops the low-scoring ones *before* the expensive graph
step, keeping `V_q ∪ V_a` and pruning only the external/expansion set `V_e`. *READS* ("LLM-based
Discriminative Reasoning for KGQA", Xu et al.) establishes the **discriminative-over-generative**
principle: constrain the system to **grounded options** rather than free generation — its ablation
(Table 3) shows removing pruning collapses Hits@1 from **0.802 → 0.548**, because a bloated/ungrounded
candidate set is the root of hallucination.

**Our novelty.** We prune by **anchor provenance over an auto-generated profiled ontology** — not
PipeNet's dependency-parse distance over a hand-built KG, and not its GNN reasoner; not READS's
Freebase option-pool format. Our relatedness signal is *did an anchor specifically ground this
terminal* — which is strictly better than dependency distance for our substrate. We keep only the
**must-include** set and let Steiner traverse unanchored bridges freely (PipeNet's `V_q ∪ V_a` vs
`V_e` distinction, applied to terminals vs the graph).

## Decision — the keep/prune rule is specificity, not a score floor

Reading the code revealed every S1 terminal is **already anchor-grounded by construction**
(`terminals` = `conceptAnchors.scopeClassIri ∪ valueAnchors.class`), so "drop terminals with no
anchor" prunes nothing. **Empirical calibration against the real F1 index** then showed a *directness
+ score floor* rule is also insufficient: the Q1 noise terminals are grounded by direct **score-1.0**
anchors (`constructorref`↔"reference"), while the needed `qualifying` is grounded at `q1`↔"first"
**0.803** — score is *inverted*. The discriminating signal is **specificity**. A terminal is kept iff:

1. an **exact class anchor** lands on it (the table name appears, score 1.0), OR
2. a **value anchor** classes to it (a data value was named), OR
3. a **specific keyword** grounds it — `df(keyword) ≤ KEYWORD_DF`, where `df` is the number of
   distinct scope classes that keyword grounds across the `AnchorSet` (an IDF-style discriminative
   term — READS's principle applied at terminal selection).

`KEYWORD_DF` defaults to **2** (env `QUERY_PRUNE_KEYWORD_DF`): profiled ontologies have parallel
entity pairs (driver/constructor), so a specific concept ("championship points") legitimately maps to
~2 classes; `df ≤ 1` over-prunes the needed table, `df ≤ 2` tolerates one parallel sibling.

## Decision — expose `scopeClassIri` on `ConceptAnchor`

`anchorQuestion` already computes each concept anchor's scope/owning class but discarded it from the
public `AnchorSet`. We add `scopeClassIri: string` to `ConceptAnchor` (set at the existing call site)
so `pruneTerminals` is a pure function over the `AnchorSet` for all three concept kinds — no
fragile capability-IRI parsing. This is **additive**: it does not change S1's recall-favoring
behavior, only stops discarding provenance.

## Recall-safety decision — prune the must-include set, not the may-traverse set

The whole correctness argument: pruning removes terminals from what Steiner must **span**, not from
what it may **traverse**. Steiner adds unanchored bridge classes at routing time, so pruning can
never disconnect a reachable answer. If pruning empties the set, a fallback keeps the single
best-grounded terminal. This reconciles recall-favoring S1 with minimal-cost S2.

## Consequences

- Canonical Q1: 8 terminals → keep {drivers, qualifying, races}, drop 5; **9-table/8-join → 4-table/
  3-join**. Happy path "average lap time for British constructors": laptimes + constructors kept,
  still connected and compiles. The `constructors` flip (dropped in Q1, kept on the happy path) is
  the visible proof the rule is question-relative, not a blocklist.
- Full provenance lands on `traces.prune` (`PruneTrace`) for the Stage-5 certificate.
- **Out of scope (next brick):** value-grounding filter values against `sampleValues` (the
  `positiontext='eliminated in first period'` hallucination). No change to Steiner weights, the
  leash, the compiler, the fixture, or the generator.
