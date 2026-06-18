# ADR-002 — Deterministic subgraph (Steiner) extraction for NL2SQL Stage 2

**Status:** Accepted · **Date:** 2026-06-18 · **Scope:** `src/query/{graph-model,graph-build,subgraph}.ts`

## Context
Stage 2 turns a set of anchored terminal tables into the join tree the compiler will emit, so the
LLM never picks a join. It routes over the qsl ontology's asserted relationships using a
metric-closure + MST Steiner 2-approximation. Three decisions are non-textbook and are the heart of
this ADR; a fourth records the H1 parameter.

## RULE A — exclude `nm__` junction edges from routing
A junction (`qsl:junctionTable`, the `nm__` many-to-many shortcut) is **not** added as a routable
edge. The junction *table* is already a node, reachable through its two real unary FK edges. Adding
the M:N shortcut would let the Steiner search hop *over* the junction and hide a table the compiler
must physically pass through, producing an unjoinable plan. → `buildGraph` skips any object property
with a non-null `qsl:junctionTable`. (Belt-and-suspenders: edges below `QUERY_EXPORT_MIN_CONF` are
also dropped.)

## RULE B — a composite join is ONE atomic edge
A multi-column FK is represented as a single `JoinEdge` carrying ≥ 2 `columnPairs`, never as two
single-column edges. Splitting it would (1) double its traversal cost and (2) let the router use
*half* a key — a join on `constructorid` without `raceid` is wrong. → composites are detected via
`qsl:compositeJoin: true` and zipped from `joinFromColumns`/`joinToColumns`; they cost their single
edge weight when traversed.

## RULE C — weight = max(1 − confidence, tier floor); **this is the H1 parameter**
Routing cost is `max(1 − confidence, tierFloor[provenance])`, with floors
`{declared: 0, discovered: 0.02, 'inferred-name': 0.30}` (env-overridable via
`QUERY_EDGE_FLOOR_DISCOVERED` / `QUERY_EDGE_FLOOR_NAME`; min-confidence cutoff
`QUERY_EXPORT_MIN_CONF`, default 0.5). The weakest-link `aggregateConfidence` is the MIN tree-edge
confidence. **`weight = 1 − confidence` is the H1 hypothesis knob**: the experimental contrast is
this weighting vs. a uniform (hop-count) router (`uniform: true`). Resolved floor values belong in
every experiment log. See [docs/experiments/h1-join-routing.md](../experiments/h1-join-routing.md).

### Tie-break (determinism rider on RULE C)
Cost is primary; equal-cost paths are ordered by: higher min-confidence → fewer hops → fewer
composite edges → lexicographically smaller ordered source-IRI list. The tie-break is *separable*
from structural guarantees: tests assert tree invariants (cost, edge count, provenance) and the
tie-break's chosen route in **separate** assertions, so tuning the tie-break later breaks only the
targeted test.

## Documented divergences from the original Stage-2 spec prose
On the committed `formula1-1781704520` fixture the **declared-FK subgraph is one zero-cost connected
component spanning all 13 classes**. Consequences, all asserted as the algorithm's real output:
- **Test 2** ({laptimes, constructors}): the spec's `…→results→constructors` route ties at cost 0.0
  with `…→qualifying→constructors`; the tie-break selects the qualifying route. Both are valid
  cost-0 all-declared trees.
- **Test 4** (composite-beats-detour): the spec's {laptimes, constructorstandings} degenerates —
  a zero-cost declared path exists, so no composite is ever chosen in confidence mode. Re-targeted to
  {laptimes, driverstandings}, where the composite wins in **uniform** mode (1 hop) and the declared
  detour wins in confidence mode (cost 0).
- **Test 6** (trim): the spec named `results`; the real winning tree routes through `qualifying`, so
  the trim assertion targets the `qualifying` bridge node.

## Consequences
- Confidence-weighting is *inert* on a fully-declared, FK-complete schema (every route already ties
  at maximal trust). The weight function's empirical effect (H1) is observed on stripped /
  incomplete-FK fixtures; the uniform-vs-confidence flip here is a *mechanism* demonstration.
- Single-best tree only; `k > 1` (Yen) reserved and throws.
- Unreachable terminals yield a partial forest (`disconnected: true`), never an exception.
