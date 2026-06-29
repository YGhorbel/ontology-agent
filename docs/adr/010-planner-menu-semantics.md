# ADR-010 — Surface ontology column semantics in the planner menu (Shape-A concept grounding)

**Status:** Accepted · **Date:** 2026-06-24 · **Scope:** `src/query/graph-model.ts`, `src/query/graph-build.ts`, `src/query/ir.ts`, `src/prompts/planner.ts` · **Relates:** [ADR-004](004-llm-planner.md), [ADR-007](007-ir-generalization.md), [ADR-009](009-value-grounding.md), [ADR-008](008-semantic-pruning.md)

## Context
The planner pipeline is anchoring → pruning → Steiner → planner → compiler → execute. A diagnostic on
**"who is the oldest driver"** produced the right query SHAPE but the wrong ranking COLUMN:

```
IR  : { select: [drivers.driverref], orderBy: [{ byProperty: drivers.driverid, dir: ASC }], limit: 1 }
SQL : SELECT drivers.driverref FROM drivers ORDER BY drivers.driverid ASC LIMIT 1   ← WRONG column
```

The IR-generalization brick ([ADR-007](007-ir-generalization.md)) correctly chose the **ranking** shape
(`ORDER BY … LIMIT 1`), but bound the order key to `driverid` (the primary key) instead of `dob` (date
of birth). "Oldest" means earliest `dob`; ordering by `id` is meaningless for age. The planner grabbed a
legal-but-irrelevant sortable column.

**Root cause — a seam leak, not a reasoning gap.** The generator wrote rich semantics on every datatype
property (`skos:prefLabel`, `skos:altLabel`, `rdfs:comment` — e.g. `dob`'s comment names it a *date of
birth* with date range `[1896-12-28..1998-10-29]`). But `ColumnProp` carried only structural/profiling
fields (`dataType` / `isNumericText` / `temporality` / `sampleValues` / `distinctCount`), and
`renderPayloadMenu` rendered only `table.column — IRI` per property. So the meaning the generator
produced was **dropped at the graph-build seam** and never reached the planner. With `dob` and
`driverid` both shown as bare legal IRIs, they are indistinguishable as sort keys.

This is the thesis premise made concrete: **the generated ontology is a knowledge substrate, but it
guides the LLM only if the LLM SEES it.** The leash ([ADR-004](004-llm-planner.md)) already uses the
ontology's STRUCTURE (which IRIs are legal); this brick makes the prompt expose its MEANING (labels,
descriptions, samples) so the planner can bind superlatives to the semantically-correct column.

**Relation to value-grounding ([ADR-009](009-value-grounding.md)).** ADR-009 surfaced a column's
`sampleValues` so the planner selects a real filter VALUE from a grounded option pool. This brick is the
same move one level up: surface a column's *meaning* so the planner selects the right COLUMN. Both
realize READS's discriminative principle — the model **chooses from grounded options** rather than
generating freely.

## Decision
Carry the generated semantics onto `ColumnProp` and render them in the planner menu — additively, with
the menu == leash invariant preserved (annotations only; the offered IRI set is byte-for-byte the same).

1. **Carry (two-file additive pattern, mirroring the `distinctCount` brick).** `ColumnProp` gains
   optional `prefLabel` / `altLabel` (normalized to `string[]`) / `description`. `columnPropOf`
   (`graph-build.ts`) reads `skos:prefLabel` / `skos:altLabel` / `rdfs:comment`, guarded the same way as
   `sampleValues`/`distinctCount`. The Stage-2 trimmer already clones `ColumnProp` via spread, so the new
   fields ride to the payload with no trimmer change.

2. **Render.** `renderPayloadMenu` annotates each property line with `prefLabel` + a (char-capped)
   `description` + — only for an **enumerable** column (reusing the exact `isEnumerable` predicate
   exported from `ir.ts`, the single source of truth shared with value-grounding) — its sample values.
   The `payloadColumnByIri` map is likewise exported and reused so the menu and the leash walk the same
   columns.

```
- drivers.dob — IRI: qsl:property/drivers/dob — "Date of birth" — Driver's date of birth (…), 821 distinct dates with range [1896-12-28..1998-10-29].
- drivers.driverid — IRI: qsl:property/drivers/driverid — "Driver ID" — Primary key for the driver table: 840 distinct values with range [1..841].
- drivers.nationality — IRI: … — "Nationality" — Driver nationality (…) … — values: American, …, British, … (+26 more)
```

**Bounds.** Descriptions cap at `QUERY_MENU_DESC_CAP` chars (default 160, env-overridable) — a
**char-cap, not first-sentence**, so a trailing directional clause / range survives. Sample lists cap at
15 with `(+N more)`. **Bridge** (non-terminal) columns render **terse** (prefLabel only) — join context,
not selection targets. `altLabel` is carried but not rendered. Payloads are already minimized by pruning
+ Steiner tie-break, so per-property descriptions are affordable (~100 tokens for a single-table payload).

## The fixture nuance (recorded honestly)
The motivating narrative imagined `dob`'s comment saying *"larger birthday = younger"*. The **committed
fixture has no such directional clause**: `dob`'s comment is *"Driver's date of birth (…), 821 distinct
dates with range [1896-12-28..1998-10-29]."* The load-bearing signal is therefore the **prefLabel "Date
of birth" + the date range**, contrasted with `driverid`'s "Driver ID" + `[1..841]` — enough for the
model to infer *oldest = earliest dob = ASC*. The char-cap (vs first-sentence) is chosen precisely so
that on a future DB whose comment *does* carry a late directional clause, the clause is not truncated
away. Tests assert on the text that genuinely exists, not the imagined clause.

## Scope — Shape A only
This targets **Shape A**: general-language superlatives (oldest / youngest / fastest / most / highest /
first) that map to a ranking over a semantically-identified column, resolvable from the column's surfaced
meaning with **no per-question or per-dimension curation**. It does **not** attempt **Shape B**
domain-specific cutoffs ("eliminated in Q1 = bottom 5 by `q1`" / `position >= 16`), which need domain
knowledge beyond a column description and remain a documented later problem. No few-shots are added in
this brick — the hypothesis is that surfacing descriptions suffices for Shape A; it is measured by live
`pnpm ask` runs across distinct superlative dimensions before deciding whether few-shots are needed.

## Consequences
- The planner can bind superlatives/filters by column **meaning**, across dimensions, from one uniform
  mechanism (no `dob` special-casing, no question pattern-matching).
- `ColumnProp`, `graph-build`, `ir.ts` (two new exports), and `planner.ts` change; the leash mechanism,
  value-grounding logic, IR shape, compiler, Steiner/pruning, the fixture, and the generator are
  untouched. menu == leash holds (test `M4`).
- Token cost rises modestly per property; bridge-terse rendering and the description cap bound it.
