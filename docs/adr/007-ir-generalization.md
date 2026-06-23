# ADR-007 — IR generalization: projection + ranking + aggregation (one grammar)

**Status:** Accepted · **Date:** 2026-06-23 · **Scope:** `src/query/ir.ts`, `src/query/compiler.ts`, `src/query/planner.ts`, `src/prompts/planner.ts` · **Relates:** [ADR-003](003-ir-and-compiler.md), [ADR-004](004-llm-planner.md)

## Context
The original `MetricQueryIR` (ADR-003) **required** a `measures` array (`z.array(MeasureSchema).min(1)`).
An intent audit of the 64 gold candidates found this shape cleanly expresses only ~22% of them —
the metric-aggregation questions. The two largest buckets need **no aggregate**:

- **Pure projection (~28%)** — `SELECT cols WHERE filter` ("the coordinates of Silverstone",
  "Bruno Senna's Q1 result").
- **Ranking/selection (~33%)** — `SELECT cols WHERE filter ORDER BY col LIMIT N`, returning rows
  ("the oldest driver", "drivers eliminated in Q1", "top 20 by lap time").

Together **61%** of gold. Because the IR mandated `measures`, the planner was forced to invent an
aggregate where none was asked for — the documented `MAX(laptimes.lap)` hallucination on the pure
ranking question f1-bird-846. The remaining ~17% (ratios, multi-CTE time math) stay out of scope and
route to a future constrained-SQL fallback lane — not this IR.

This is a logical-form **generalization, not a rewrite**: the IR already had `orderBy`, `limit`,
`filters`, `groupBy`; the gap was that `measures` was mandatory and there was no plain projection.

## Decision 1 — three shapes under one grammar, discriminated by presence (no tag)
Make `measures` optional and add a `select` projection list. One IR is exactly one of:

1. **projection** — `select` (+ `filters?`, `distinct?`); no measures, no groupBy.
2. **ranking** — projection **+ `orderBy`** (+ usually `limit`). Mechanically "projection that has
   `orderBy`" — **not** a separate discriminant tag.
3. **aggregation** — `measures` (≥1) (+ `groupBy?`); the original shape, unchanged.

The shape is determined by *which fields are present*, enforced with top-level zod `.refine`s
(`select` XOR `measures`; `groupBy` only with `measures`; `distinct` only with `select`). This
matches the repo's existing idiom — `MeasureSchema` and `OrderBySchema` already use presence-XOR
`.refine`, not `z.discriminatedUnion`. Treating ranking as projection-with-`orderBy` (rather than a
tagged variant) is justified because the compiler emits identical machinery for both and the leash
constrains them identically; a tag would add a field the compiler never branches on.

**Precedent.** ArcaneQA extends its S-expression logical form with new operators for constraints the
base form can't express; we likewise extend the base IR rather than bolt on a parallel form. SPEDN
treats ordering/selection as **first-class intents distinct from aggregation** — exactly the
projection/ranking-vs-aggregation split adopted here.

## Decision 2 — the leash extends to `select`; mechanism unchanged
`specializeIrSchema(payload)` is the planner's leash: it rejects any IRI outside the payload. Its
`superRefine` now also walks `select[].property` (alongside `measures`, `groupBy`, `filters`,
`orderBy.byProperty`). The *mechanism* (set-membership checks with precise issue paths) is untouched;
only its coverage grew. This is critical — `select` is where out-of-payload projection columns would
otherwise leak, so the leash must narrow it for the new shapes to be safe.

## Decision 3 — compiler additions are minimal and reuse existing helpers
- **SELECT assembly:** projection emits bare qualified `table.col` (matching gold `SELECT
  circuits.lat, circuits.lng`); `distinct: true` → `SELECT DISTINCT`. Projection/ranking never force
  a GROUP BY (it stays presence-gated on `ir.groupBy`).
- **Text-numeric ORDER BY:** several ranking golds sort over text columns holding numbers
  (`results.fastestlapspeed`) where lexical ≠ numeric order. The ORDER BY path reuses the existing
  `maybeCast` (the same `isNumericText` cast the aggregate/filter passes use) so the sort is numeric.
  Time-formatted text (`"1:23.796"`) is not a clean numeric cast and is a documented limitation.
- **NULLS:** optional `orderBy.nulls`; emitted only when set, else Postgres' native default applies.
- Join, temporality, filter, numeric-text-cast, and parse-check passes are unchanged. The compiler
  still renders payload joins verbatim and never selects a join.

The planner prompt was bumped to `planner/v2` (shape-first instruction + projection/ranking
few-shots); the bounded-repair loop and leash plumbing are unchanged in shape.

## Out of scope (route-later)
Ratios/percentages and multi-CTE time math (~17% of gold) → future constrained-SQL fallback lane.
`DISTINCT` is supported for projection; `HAVING`, window measures, set operations, and time-string
ordering remain not expressible and preserve the clean "wrong IR vs wrong compiler" separability.
