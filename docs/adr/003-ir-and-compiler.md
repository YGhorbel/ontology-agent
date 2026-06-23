# ADR-003 — IR + deterministic compiler (Stage 3b)

Status: accepted · Date: 2026-06-18 · Supersedes nothing · Relates to ADR-002 (subgraph extraction)

## Context

Stage 3 turns an anchored question into SQL. We split it into a planner (Stage 3a, an LLM that emits
a logical plan) and a deterministic compiler (Stage 3b, this ADR). Stage 3b is built and proven
*first*, on hand-written IR, with no LLM.

## Decision 1 — the LLM emits IR, not SQL

The planner emits a typed `MetricQueryIR` (capabilities/properties as ontology IRIs), never SQL. The
compiler is the only component that writes SQL.

**Why.** Once the compiler is locked on hand-written IR, every end-to-end failure is attributable to
*either* "the LLM planned wrong IR" *or* "the compiler is wrong" — never an ambiguous blur. That
separability is the most valuable debugging property in the system, and it only exists if SQL
generation is deterministic and isolated. `specializeIrSchema(payload)` will constrain the LLM to a
specific payload's IRIs (the leash), so malformed plans fail at the schema, not in SQL.

## Decision 2 — temporality is a compiler pass (the H2 mechanism)

Cumulative-snapshot columns (running totals like `driverstandings.points`) are de-cumulated by the
compiler — snapshot-at-max-order per `(entity, season)` via a `ROW_NUMBER` derived table — rather
than trusting a naive `SUM`/`AVG`. A per-race column (`results.points`) compiles to a plain `SUM`.
This distinction *is* H2; making it a deterministic pass (driven by `temporalityEvidence`) means the
correctness lives in code, not in the LLM's judgement.

The grain is frequently **cross-table** (the season/order columns live in a calendar table reached
by a FK). The compiler folds that calendar join into the derived table **using an edge already in
`payload.joins`** — it never re-derives or chooses a join. Unreachable grain is a loud
`CompileError`, never a guess.

## Decision 3 — enrich the payload at the Stage-2 seam (not a 3rd compiler arg)

The trimmed `SubgraphPayload` did not carry `formulaHint`/`unit` (on capabilities) or
`isNumericText`/`temporalityEvidence` (on columns) — facts passes 1/2/4/6 need. We **additively
enriched** `ColumnProp` and `CapabilityRef` at the projection seam (`columnPropOf` /
`loadCapabilities` in [graph-build.ts](../../src/query/graph-build.ts)), keeping `compile(ir, payload)`
two-argument and Stage-2 *routing* untouched.

**Why not a 3rd `OntologyIndex` argument.** It would re-introduce a second source of truth (the full
graph) alongside the payload and blur "the payload is the scope authority." Additive fields are
purely optional, so existing Stage-2 tests (which assert individual fields, never whole-object
equality) stay green.

**Consequence.** A measure/filter/grain column reaches the compiler only if it is in the payload, so
Stage-1 anchoring must retain it (`opts.anchoredColumns`). The compiler asserts presence and fails
loudly otherwise — no silent fallback.

## Determinism guarantee

Given the same `(ir, payload)`, `compile` is a pure function: no clock, no randomness, no DB, no LLM.
Relation alias = table name; the only generated identifier is `__qsl_snap_rn`. Output is parse-checked
before return. Joins are emitted verbatim from `payload.joins`.

## Consequences

- Stage 3a (planner) can be built against a frozen, tested compiler.
- The eventual certificate can cite the compiler `trace` (which pass produced which clause).
- Known gap (deliberate): a capability whose `formulaHint` naively aggregates a cumulative column is
  not rewritten (formulaHints expand verbatim). Detecting/curing that is future work or a generator
  concern, kept out of Stage-3b scope.
