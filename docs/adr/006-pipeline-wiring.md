# ADR-006 — Stage 4 pipeline wiring (S1→S2→S3a→S3b→execute as one flow)

**Status:** Accepted · **Date:** 2026-06-18 · **Scope:** `src/query/pipeline.ts`, `scripts/ask.ts` · **Relates:** [ADR-002](002-subgraph-extraction.md), [ADR-003](003-ir-and-compiler.md), [ADR-004](004-llm-planner.md), [ADR-005](005-anchoring.md)

## Context
All five query stages existed and were unit-verified in isolation, but the full chain had never run
as one flow. This brick wires them together — integration only, no stage-internal changes, no gold
or accuracy scoring, no fallback lane. Three decisions define the wiring.

## Decision 1 — LangGraph, not a plain async sequence
The repo's only existing multi-stage flow (`src/agent/graph.ts`, the ontology generator) is built
on `@langchain/langgraph` `StateGraph` + `Annotation.Root` with node factories that close over
injected deps and conditional-edge routers. We mirror that exactly rather than writing a bespoke
`await a(); await b();` chain. The win is not the happy-path sequence (a plain chain would do) but
the **conditional routing**: two stages can terminate the flow early, and LangGraph's
`addConditionalEdges` expresses "this node decided we're done" as a first-class edge, with the
shared `traces` channel accumulating provenance across whichever path runs. It also keeps Stage 4
stylistically consistent with Stage 0 so there's one graph idiom in the codebase. → `buildPipeline`
returns a compiled `StateGraph`; `runPipeline` invokes it.

## Decision 2 — failure as a graceful terminal state, not a throw
S2 (`disconnected`) and S3a (`repair-exhausted`) can fail; S3b (`CompileError`) and execute can too.
Every fallible node **writes a `failure` slice and routes to `END`** via a shared
`routeOnFailure(next)` conditional edge, carrying the partial `traces`. The graph never throws on an
expected failure; `runPipeline` returns `{ ok:false, failure, traces }` naming the stage that
stopped. This is deliberately **not** the constrained-SQL fallback lane (a later brick) — it is the
minimal "don't crash, surface where and why" contract the certificate and the future fallback will
both build on. Unexpected throws (a non-`CompileError` bug) still propagate, by design.

## Decision 3 — derive `anchoredColumns` at the wiring seam (the H2-load-bearing step)
S2's `extractSubgraph` takes an optional `anchoredColumns` map and its trimmer drops every column
that isn't a join key, anchored, or a terminal sample. A cumulative measure column like
`driverstandings.points` — and its `temporalityEvidence` — therefore vanishes unless the wiring
tells S2 to keep it. So the pipeline **derives the map from the AnchorSet** (`deriveAnchoredColumns`,
exported and pure): valueAnchors contribute their column under `.class`; `kind:'property'` concept
anchors contribute their column under the class parsed from the property IRI; class/capability
anchors contribute none. Deriving it here (not inside any stage) keeps the S1→S2 contract a plain
data handoff and makes the derivation independently testable. Without it the compiler would emit a
silent naive `SUM`; with it the evidence survives and the compiler either applies the H2 snapshot
rewrite or refuses loudly.

## Consequence — a verified seam gap (documented, deferred)
The derivation is proven (evidence survives the trim end-to-end), but the snapshot rewrite does not
fire end-to-end on the broad recall-favoring payload: the `driverstandings→races` calendar edge is a
discovered FK (conf 0.95) that S2's confidence-weighted tree never selects, and the fold's grain
columns aren't anchored by a natural question. The compiler then refuses with `temporality-
unreachable` (graceful `failure.stage:'compiler'`), so CRITICAL #1's real guarantee — no silent
wrong aggregate — holds. The rewrite is proven on a tight uniform payload fed by the same
derivation. Closing the gap (routing/anchoring the calendar edge) and the related over-join cost
issue are deferred accuracy work. See [docs/query/pipeline.md](../query/pipeline.md).
