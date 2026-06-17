# ADR 000 — NL2SQL evaluation methodology

**Status:** Accepted — 2026-06-17

> **Update 2026-06-17:** verified against `github.com/bird-bench/mini_dev`. We now ship the
> official BIRD metrics as **exact ports** — `birdStrictMatch` (= `calculate_ex`), `softF1`
> (= `calculate_f1_score`), and R-VES (= `evaluation_ves.py`) — validated value-for-value
> against the upstream Python on our fixtures. The official **EX (strict)** is the headline,
> comparable number; our order-aware/epsilon/coercion scorer is retained as a labeled
> diagnostic **EX+**, and the run reports their disagreement count. Also confirmed: the
> official Postgres setup loads `BIRD_dev.sql` into a single `BIRD` database (our 11-DB split
> is our own substrate choice), and our gold copy is the canonical 500-item set.

## Decision

The eval harness scores NL2SQL output with several scorers: **BIRD strict EX** (the
published, comparable headline), **Soft-F1** and **R-VES** (BIRD's own metrics), our
order-aware **EX+** diagnostic, and **numericCorrectness** for numeric results.

### Why BIRD-style set-based EX

EX compares the candidate and gold result sets as **sets of row-tuples**, order-insensitive
unless the gold has a top-level `ORDER BY`, columns by position. We adopt exactly this so our
numbers are **directly comparable with published BIRD/NL2SQL results** — a different
correctness definition would make our accuracy incommensurable with the literature we are
measuring against. The known cost is that set comparison ignores row multiplicity (duplicate
rows collapse); we accept it for comparability rather than inventing a bespoke metric.

### Why a second `numericCorrectness` scorer exists

EX **under-detects the silent-wrong-number failure class (H2)**: a candidate can satisfy EX
while returning a wrong magnitude — because the result *set* happens to coincide, because
duplicates collapse, or because a flawed gold and a flawed candidate agree. For aggregate and
labeled-series answers this is the failure mode we most need to catch, so `numericCorrectness`
pins the value(s) directly with a tolerance, independently of EX. The two scorers are
deliberately independent, and **their disagreement is a reported finding**, not a bug to
reconcile — it quantifies how often EX would have masked a wrong number.

### Supporting decisions

By-position column comparison (generated SQL won't match gold aliases), relative float
epsilon `1e-6`, `NULL = NULL`, and numeric-text coercion (`'1' == 1`) — each documented with
its rationale and risk in [../eval.md](../eval.md).

## Revisit trigger

Revisit this ADR if any of the following hold: (a) a target leaderboard/benchmark we report
against changes its official EX definition (e.g. multiset or value-rounding semantics);
(b) numeric-text coercion is shown to mask a real wrong-answer on actual gold (e.g. a
zero-padded identifier collides with its integer); or (c) numericCorrectness and EX agree on
~100% of items across real suites, indicating the second scorer no longer earns its cost.
