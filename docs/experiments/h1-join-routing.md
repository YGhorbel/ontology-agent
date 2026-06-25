# H1 — Confidence-weighted join routing

**Hypothesis (H1).** Weighting join edges by `1 − confidence` (RULE C) lets the deterministic router
pick *better* join paths than a confidence-blind, hop-count-minimising router — choosing
trustworthy foreign keys over plausible-but-weaker discovered/name-matched joins.

## The key empirical caveat (do not skip this)
**On the intact `formula1` schema the declared foreign keys form a single zero-cost spanning
subgraph: every table is reachable from every other via declared FKs at total cost 0.0. So
confidence-weighting is INERT here — every route already ties at maximal trust, and the weight
function changes nothing.** H1's real effect only shows on **stripped / incomplete-FK schemas**,
where some required hops have no declared FK and the router must choose among
discovered/inferred-name edges of differing confidence. This is *why the stripped fixtures exist*.

Concretely, on intact formula1 the confidence-mode winner for any terminal pair is an all-declared
tree at cost 0.0; composite and discovered edges (weight > 0) are never on the optimal tree.

## Mechanism demonstration vs. empirical result
The **uniform-vs-confidence flip** in the unit tests (e.g. {laptimes, constructors}: uniform picks
the 2-edge composite `laptimes→qualifying→constructors`; confidence picks the 3-edge all-declared
route) proves the weight function *can* change the chosen tree. That is a **mechanism demo**, not the
empirical H1 result — it only shows the knob is wired correctly. The empirical H1 measurement must
run on FK-stripped / incomplete fixtures where confidence actually discriminates between candidate
routes.

## Experiment design (for the runner; not implemented in this task)
- **Arms:** `confidence` (RULE C weights) vs. `uniform` (all weights = 1).
- **Fixtures:** intact `formula1-1781704520` (control — expect no difference) **plus** stripped
  variants with declared FKs removed so discovered/inferred-name edges are load-bearing.
- **Log every run:** resolved knobs — `QUERY_EXPORT_MIN_CONF`, `QUERY_EDGE_FLOOR_DISCOVERED`,
  `QUERY_EDGE_FLOOR_NAME` — plus per-query `aggregateConfidence`, `totalCost`, `bridgeNodes`, and the
  chosen join set, for both arms.
- **Metric:** downstream NL2SQL execution accuracy of the compiled plan per arm, paired by question.

## 4th manifestation — the tie-break, not the weights, decides topology (2026-06-23)
The Steiner objective gained a secondary key: **minimum-cost, then minimum edge count** (ADR-002
addendum). The trigger: pruned terminals `{drivers, qualifying, races}` routed a needless 3-join tree
through `laptimes` when a cost-equal 2-join tree existed — both cost 0.0. This is the **4th** decision
driven by the zero-cost spanning-subgraph property (after: H1 inert on intact F1; the S3b cumulative
test forced into uniform mode; the cumulative calendar-fold edge sitting off the least-cost tree).

Reinforces the caveat above: on intact F1 **cost cannot discriminate**, so the *tie-break* — now
`(cost, edge-count, lexicographic)` — determines the chosen topology. H1's weighting is only testable
on stripped / incomplete-FK schemas where cost actually varies between routes; on the intact schema
both the weighting *and* the cardinality key operate entirely within the cost-0 tie.

## Status
Mechanism wired and unit-tested (Stage 2). Empirical comparison pending the stripped fixtures and the
NL2SQL eval harness.
