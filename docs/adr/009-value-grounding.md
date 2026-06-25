# ADR-009 — Value-grounding: filter literals constrained to a column's sample domain

**Status:** Accepted · **Date:** 2026-06-23 · **Scope:** `src/query/ir.ts`, `src/query/graph-model.ts`, `src/query/graph-build.ts`, `src/query/subgraph.ts` · **Relates:** [ADR-003](003-ir-and-compiler.md), [ADR-004](004-llm-planner.md), [ADR-002](002-subgraph-extraction.md), [ADR-008](008-semantic-pruning.md)

## Context
The leash (`specializeIrSchema`, ADR-003/004) constrains which **IRIs** the planner's IR may
reference — columns, capabilities, properties — to the payload: the planner cannot name a column
outside the payload. But it did **not** constrain filter **values**. So the planner could emit a
filter whose *property* is grounded but whose *value* is hallucinated. The documented case: for
"drivers eliminated in the first period" a run emitted `results.positiontext = 'eliminated in first
period'` — a string present in no row, so the query returns zero rows. Several enum-filter gold
questions ("British" constructors, "Germany" circuits, "Japanese" drivers, "Spanish Grand Prix"
races) depend on the value matching a real profiled value.

**Precedent — READS / LDR** (*LLM-based Discriminative Reasoning for KGQA*, arXiv 2412.12643).
READS reformulates KGQA constraint selection as **discriminative**: it maintains an *option pool* of
grounded candidate constraints and "asks the LLM to iteratively select the constraints until the LLM
selects 'None' or there is no options left" — the model **chooses** from grounded options rather than
**generating** a free value. Its ablation (Table 3, "Ignore constraints") quantifies the cost of
dropping this: CWQ Hits@1 **0.802 → 0.548** (WebQSP 0.840 → 0.737). The transferable principle: a
freely-written constraint value is a hallucination risk; constraining it to a grounded option pool is
what kills it.

Our leash already applies the discriminative principle to **IRIs** (the planner selects
columns/capabilities from the payload menu, can't invent them). Value-grounding **extends the same
principle to filter VALUES**: the literal must be grounded in the column's profiled `sampleValues`, or
it is rejected into the repair loop with the available values surfaced as the option pool. This is the
SQL-side instantiation of READS's constrained option pool.

This is **not** concept-grounding. `qualifying.position >= 16` (a wrong *interpretation* of a domain
concept — 16 is a valid integer) is explicitly out of scope; that is a later, separate design. This
ADR targets ungrounded **literals on enumerable text columns**.

## Decision 1 — ground only enumerable equality filters; everything else is a no-op
For a filter `{ property, op, value }`, GROUND the value (require a match) when **all** hold:

1. **op is equality/membership** — `=`, `!=`, `IN`. Range/pattern ops (`<`, `<=`, `>`, `>=`, `LIKE`)
   SKIP. The **op-gate, not the column type, is the guard**: `qualifying.position` *is* an enumerable
   enum in the fixture, yet `position >= 16` is correctly never grounded because `>=` is a range op.
2. **value is a string** (or, for `IN`, an array of strings). Numeric values (ids/years/ints) SKIP.
3. **column is enumerable** — it carries `sampleValues` AND `distinctCount <= sampleValues.length`
   (the payload holds the column's *full* domain).

The enumerability predicate `distinctCount <= sampleValues.length` is **self-protecting**: if a
column's samples were ever truncated (`length < distinctCount`), it evaluates false → SKIP, so a
real-but-unlisted value is never wrongly rejected. This is sound because of an **existing generator
invariant**: the profiler only emits `sampleValues` when `distinctCount <= ONTOLOGY_ENUM_MAX_DISTINCT`
(50), and when it does it lists the *whole* domain — so "has a full sample list" ⇔ "the domain is
known" (the same gate `src/agent/nodes/05-validate.ts` uses to validate comment-cited values).

SKIP is the safe default — value-grounding only ever FIRES on enumerable equality filters; on
free-text / high-cardinality (`drivers.surname`, 784 distinct, no samples) / numeric columns it is a
no-op, so it cannot reject legitimate name/date/id filters.

**Match semantics.** Exact membership → pass. Match only after `normalize()` (the existing
`text-normalize.ts`: NFKD + diacritics + lowercase + punctuation/whitespace fold) → pass **and rewrite
the literal to the canonical sample** (`'british'` → `'British'`), fixing case/diacritic-mismatch
golds. No match on an enumerable column → reject.

## Decision 2 — placement in the leash; option pool in the issue message; rewrite via transform
Value-grounding lives **inside `specializeIrSchema`** (placement (a)): the payload is already in the
closure, so `sampleValues`/`distinctCount` are reachable, and all constraint logic stays in one place.
The IRI **mechanism is untouched** (set-membership checks with precise issue paths); coverage grew to
filter values. A rejection is emitted as a `superRefine` ctx issue at path `['filters', i, 'value']`
whose **message carries the option pool** (the sample list, capped at 15). It therefore flows through
the *existing* `formatIssues → buildPlannerPrompt` repair plumbing **unchanged** — a value-grounding
rejection is just another leash-style rejection fed back into the prompt, mirroring READS's
"offer the grounded options".

The normalized-match **rewrite** is a trailing `.transform()` on the specialized schema. Zod runs a
transform only after refinements pass (no issues), so on success every grounded literal is guaranteed
to match; the transform rebuilds `ir.filters` mapping each grounded value to its canonical sample and
returns a **new** IR (no mutation of input or payload). The schema's `z.ZodType<MetricQueryIR>` return
is preserved (transform output stays `MetricQueryIR`), and the bounded repair loop is reused verbatim:
`leash.safeParse(raw)` still the single call, `parsed.data` now carrying canonical values to the
compiler. The compiler's SQL passes are unchanged — it renders whatever literal the IR holds.

## Decision 3 — carry the full enum domain to the leash (S2 trim lifted for exhaustive enums)
Value-grounding can only match against the domain the payload actually carries. Two additive payload
changes make that domain available:
- `distinctCount` is now carried onto `ColumnProp` (`graph-build.ts`, mirroring `sampleValues`); the
  `qsl:distinctCount` annotation already existed in the ontology and was merely not propagated.
- The S2 column trim ([ADR-002](002-subgraph-extraction.md), `subgraph.ts`) previously truncated every
  terminal column's `sampleValues` to 15. The gold enum columns all exceed 15 (nationality 41, country
  32, races.name 42, positiontext 39), so the truncation would make the self-protecting predicate skip
  exactly the columns this brick targets. The trim now keeps the **full domain for exhaustive enums**
  (`distinctCount <= sampleValues.length`, ≤ 50 by the generator cap) and applies the 15-cap only to
  any non-exhaustive sampled column. Bridge-node columns still drop samples (context discipline).

## Out of scope (route-later)
- **Concept-grounding** — wrong *interpretation* of a domain concept (`position >= 16` meaning
  "eliminated in Q1"). The value is a valid integer; the error is semantic, not lexical. Separate brick.
- Grounding range/pattern ops, or rejecting values on non-enumerable / high-cardinality / no-sample
  columns — deliberately never done; the default is accept.
