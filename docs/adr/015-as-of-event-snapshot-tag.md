# ADR-015 — Tag as-of-event snapshot columns the monotonicity probe misses (tier-2 grain)

**Status:** accepted · **Stage:** generator node ①b (profiling) · **Refines
[ADR-013](013-menu-grain-distinguishers.md)** (feeds the menu grain tag) · **Acts on
[grain-separability](../diagnosis/grain-separability.md)** · **Does NOT touch
[ADR-014](014-sibling-survival.md) routing or [ADR-012](012-from-back-prune.md)**

## Context

The grain-separability diagnostic decomposed grain resolution into three tiers:

- **Tier 1 (operation-determined).** Operation shape ⇒ grain deterministically (`AGG_OVER_EVENTS` ⇒
  per-event; unpinned `MAX` ⇒ cumulative). Graph-constrainable — a separate brick, later.
- **Tier 2 (TAG-GAP) — this ADR.** The right column exists but the generator **under-tagged** it.
- **Tier 3 (intent-dependent, irreducible).** 869 vs 950: structurally identical SQL, opposite grain,
  separable only by question intent. **No generated metadata fixes this.**

The Fix-3 temporality probe ([`monotonicity.ts`](../../src/profiling/monotonicity.ts)) detects a
cumulative measure by **monotonicity**: `value − LAG(value)` non-negative for ≥ 99 % of rows along the
calendar sequence. That correctly tags running totals (`driverstandings.points`,
`constructorstandings.wins` → `cumulative-snapshot`). But a championship **`position`** is a genuine
as-of-event snapshot (the standing *as of* a race) that is **not monotonic** — a competitor drops
2nd→4th — so the probe misses it. `driverstandings.position` / `constructorstandings.position` carried
**no** `qsl:temporality`, byte-identical to per-event `results.position`. The planner Move-1 menu
([ADR-013](013-menu-grain-distinguishers.md)) was therefore **grain-blind** for the position family
(diagnostic cases 896, 902): even with both grain siblings retrieved ([ADR-014](014-sibling-survival.md)),
there was no tag to mark the cumulative one.

## Decision

Add a second, data-grounded probe ([`snapshot.ts`](../../src/profiling/snapshot.ts), node ①b, after
the monotonicity probe) that detects **as-of-event snapshot** columns **generally** — not a `position`
special-case — and emits a new temporality value **`as-of-event-snapshot`**.

### The general definition

A column `c` on table `T` is an as-of-event snapshot when BOTH hold (no column-name special-casing):

1. **Functional determination (structural grain coherence).** `T`'s grain is exactly `(entity, event)`
   — exactly one row per `(entity, event)` — so `c` is a STATE as-of the event, not one of many
   per-event measurements. Checked from data: `count(*) == count(distinct (entity…, eventKey))`.
2. **Carry-forward (data).** Along the event order, for a fixed entity, `c`'s values form a trajectory
   rather than independent per-event draws. Measured by the von Neumann ratio `var(Δ) / var(v)` per
   `(entity, season)` partition: ≈2 for an i.i.d. draw, →0 for a smoothly carried-forward state; below
   `ONTOLOGY_SNAPSHOT_MAX_VN_RATIO` ⇒ carried-forward. A minimum non-zero-step fraction
   (`ONTOLOGY_SNAPSHOT_MIN_MOVE_FRAC`) additionally excludes a near-constant attribute.

Monotonic-cumulative is the *special case* already detected (and is skipped here — those columns keep
their stronger `cumulative-snapshot` tag). For tables with NO cumulative column at all (e.g. a finance
`accounts.balance` as-of-date), the two gates still fire — this is what generalizes the probe beyond F1.

#### Two planned signals were FALSIFIED by the live data (the verify step earned its keep)

The diagnostic proposed *table-coherence* (key off an already-cumulative sibling) and a *range-normalized
step* carry-forward. Running against the live F1 DB before committing showed both were wrong:

- **Table-coherence inherits a constant-column cumulative false-positive.** `qualifying.number` is
  constant per season ⇒ trivially monotonic non-decreasing (ratio 0.9967) ⇒ already (mis)tagged
  `cumulative-snapshot` in the committed fixture. Table-coherence would then drag **`qualifying.position`**
  (a per-event qualifying result) in as a snapshot. Replaced by **functional determination**, a structural
  grain-coherence gate that does not depend on a sibling's tag.
- **Range-normalized step over-fires.** `avg(|Δ|)/range` tagged *every* per-event F1 column
  (`results.position`, `results.points`, `laptimes.*`, …) because a global range dwarfs within-entity
  steps. Replaced by the **von Neumann ratio**, which actually measures autocorrelation. Live separation
  is clean: standings `position` ≈ 0.046–0.049 vs `qualifying.position` 0.514, `results.position` 0.800,
  `results.points` 0.944.

The corrected pair tags **exactly** `driverstandings.position` and `constructorstandings.position` on F1,
and nothing else — `results.*` also fails functional determination (historic shared drives make
`(driver, race)` non-unique), `laptimes`/`pitstops` are multi-row-per-event telemetry.

### A distinct tag value, not an umbrella

`as-of-event-snapshot` is deliberately **distinct** from `cumulative-snapshot`. Every consumer that does
*special behavior* keys on the exact string `cumulative-snapshot`:

| Consumer | Behavior | File |
|---|---|---|
| compiler de-cumulation (H2) | `SUM→MAX−FIRST` per partition | `src/query/compiler.ts:139` |
| validate SUM backstop | hard-fail `cumulative-no-sum` | `src/agent/nodes/05-validate.ts:89` |
| concept-extract hint | "CUMULATIVE (running total…)" | `src/prompts/concept-extract.ts:79` |
| capability never-SUM list | "never SUM these" | `src/prompts/capability-infer.ts:84` |
| **planner menu renderer** | **generic** `replace(/-/g, ' ')` | `src/prompts/planner.ts:105` |

So the new value flows **only** to the generic renderer → `[as of event snapshot]`. This is correct: a
rank is a *state*, not a running sum — it must **not** be de-cumulated or SUM-failed. It also keeps the
regenerate-diff clean, because the new value enters **no** LLM prompt.

### Symmetric tagging (the discrimination is the point)

A per-event sibling (`results.position`: a table with no cumulative sibling, volatile finishing
position) is tagged by **neither** signal and stays untagged — distinguishable from the standings
snapshot. The tag is only useful if it discriminates; both directions are tested.

### Regenerate-and-diff (blast-radius control)

The fix lives in the generator; the artifact is **regenerated**, never hand-edited. Regeneration
re-runs the two LLM nodes, whose free-text and capability `@id`s resample, so
`generate --freeze-text-from <old>` ([`artifact-merge.ts`](../../src/serialize/artifact-merge.ts))
carries those fields over by `@id`, and `scripts/temporality-diff.ts` reports intended tag changes vs
any other change (target 0), exiting non-zero on drift. The fixture is replaced only after a clean diff.

## Prior art

- **OntoKG (arXiv 2604.02618).** Intrinsic-relational routing makes each property's type a *declared,
  first-class, reusable schema facet*, detected by **grounding tools against the actual KG**. We adopt
  the principle: temporal-grain is a declared facet on intrinsic state columns, emitted by the generator
  and consumed downstream, detected from the **data** (functional determination + carry-forward), not
  from column names. The analogy is *structural* — their facet is entity typing, ours is temporal grain — not
  literal; their evidence that a generated type facet rivals a curated one (controlled-candidate subset,
  +2.4 macro over YAGO 4.5) is the support for emitting grain as generated metadata.
- **Talisman, "Systems for Organizing."** "An entity is defined by its position in the network… remove
  the relationships and the entity loses its semantic identity." The grain facet is part of a column's
  semantic identity; under-tagging strips it. KOS framing: the generator *earns* semantics by profiling
  rather than hand-curation.

## Consequences

- **Tag-gap closed.** Standings `position` columns (and any as-of-event snapshot the probe finds) now
  carry the tag; per-event siblings stay untagged. The position-family menu is no longer tag-blind.
- **Infrastructural, not a metric win on its own.** This does not by itself flip 896/902 — they also
  need the tier-1 operation⇒grain resolver to *use* the now-present tag (and 902 is also an S1/anchoring
  miss). **EA impact ≈ 0–1 alone**; the payoff is **unlocking tier-1** for the position family.
- **Does NOT touch tier 3.** The 869/950 intent collision is unchanged — no generated metadata
  separates "highest point **in** race 9" (per-event) from "0 points **at** race 291" (cumulative).
- **Cross-domain.** Both signals are schema-agnostic, so the probe tags standings-style snapshots in any
  sport, `balance`-as-of-date in finance, `on_hand`-as-of-date in retail — no F1 strings.

## Scope (explicit)

Closes the tier-2 tag-gap. Does **not** build tier-1 (operation⇒grain), does **not** touch tier-3
(869/950). No change to planner/prune/sibling-survival/compiler/IR logic or the Move-1 renderer — only a
new temporality value flowing through the existing generic render path.
