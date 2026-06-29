# ADR-016 — Tier-1 operation⇒grain resolver: resolve where deterministic, surface where irreducible

**Status:** accepted · **Stage:** 3a.5 (between the S3a planner and the S3b compiler) · **Consumes
[ADR-013](013-menu-grain-distinguishers.md) + [ADR-015](015-as-of-event-snapshot-tag.md)** (the grain
tags) · **Composes with [ADR-014](014-sibling-survival.md)** (FK-symmetric sibling set) **and
[ADR-012](012-from-back-prune.md)** (back-prune) · **Acts on
[grain-separability](../diagnosis/grain-separability.md)**

## Context — the three-tier decomposition

The grain-separability diagnostic decomposed grain resolution into three tiers:

- **Tier 1 (operation-determined) — THIS ADR.** For the non-colliding operation shapes, operation⇒grain
  is a clean deterministic function: `AGG_OVER_EVENTS ⇒ per-event` (aggregating an already-cumulative
  column double-counts), unpinned `MAX_OR_LATEST ⇒ cumulative/standings`.
- **Tier 2 (tag-gap)** — closed by [ADR-015](015-as-of-event-snapshot-tag.md): standings `position`
  columns now carry `as-of-event-snapshot`; per-event siblings stay untagged.
- **Tier 3 (intent-dependent, IRREDUCIBLE)** — the `ASOF_EVENT_FILTER` shape **collides**: 869 ("highest
  point IN race 9" → per-event) vs 950 ("0 points AT race 291" → cumulative) are structurally identical,
  separable only by question intent. The diagnostic proved **no** structural/tag signal separates them.

This brick is buildable now because both prerequisites landed: sibling-survival (ADR-014) keeps BOTH
grain candidates in the payload, and the generator (ADR-013 + ADR-015) tags each candidate's grain. So
for the first time both siblings are present **and** grain-labelled at the binding point.

## Decision — the boundary is as load-bearing as the rule

Build the deterministic rule **and** the collision-detector together. Building the rule WITHOUT the
detector would just move the 950 coin-flip into confident code — guessing harder, which is worse. The
resolver MUST be deterministic where the operation separates grain, and MUST explicitly DETECT and
SURFACE where it does not.

### 1. Operation shape — derived FROM THE IR STRUCTURE (lexicon-free)

`resolveGrain(ir, payload, graph)` does **not** receive the question string — a lexical cue cannot leak
in (the structural H4 guarantee). Per grain-competitor column, **pin-first**:

- **`ASOF_EVENT_FILTER`** — a single-event pin present: (a) an `=`-to-constant filter on a **join-key
  column name** (`raceId = 291`; `points = 0` is *not* a pin — the grain column is not a join key), or
  (b) `orderBy` + `LIMIT 1` by a non-grain ordering. ⇒ **surface**.
- **`MAX_OR_LATEST_UNPINNED`** — `MAX`/`MIN` on the grain col, or `ORDER BY` the grain col + `LIMIT`, no
  pin. ⇒ implied **standings** ⇒ bind the tagged sibling.
- **`AGG_OVER_EVENTS`** — `SUM`/`AVG`/`COUNT` on the grain col, no pin. ⇒ implied **per-event** ⇒ bind
  the untagged sibling.
- **`PER_ROW_SELECT`** — bare projection, no aggregate, no pin. ⇒ no-op (conservative).

Pin-first is the correct asymmetry: a wrongly-flagged ambiguity costs a flag; a wrongly-*resolved* one
costs a silent wrong answer. When in doubt, flag.

### 2. Resolve rule (separable shapes)

The grain-competitor trigger is the **FK-symmetric sibling component** (ADR-014's exact `fkSymmetric`
test, now exported) of the planner's binding, restricted to members of differing grain. FK-symmetry is
load-bearing: it confines a rebind to a true grain sibling and **never swaps the entity** — a `points`
column also lives on `driverstandings`, but it is FK-symmetric to neither constructor table, so it is
never a target. If the planner bound the wrong grain, rewrite the column's IR slots to the **unique**
sibling of the implied grain. Implied grain is **binary** (per-event vs standings); each component has
exactly one untagged + one tagged member, so the pick is unambiguous. The defensive guard: a non-unique
target (≥2 distinct non-per-event tags) → surface, not guess — so the simplification degrades to honesty
on a future DB where it does not hold.

### 3. Surface rule (the irreducible ASOF case — never guess)

On `ASOF_EVENT_FILTER`, emit `grainResolve.ambiguities` (competing candidates + grains + a structural
note) and **keep the planner's binding** as the documented non-interactive fallback — an honest recorded
ambiguity for the eventual certificate/interactive brick to consume. No lexical tie-break to "win"
869/950 (explicitly out of scope; would break H4). The brick's tier-3 deliverable is **detection +
honest flagging**, not a pick.

## Composition

- **Back-prune (ADR-012):** after a rebind the unreferenced sibling is an FK-symmetric degree-1 leaf →
  dropped from FROM; no over-join. A reference split would require binding a non-grain column of the
  source sibling, which only co-occurs with a join-key pin (= ASOF, never rewritten).
- **Move-1 menu (ADR-013):** surfaces grain to the LLM. This resolver is the deterministic safety net
  that binds grain from evidence for separable shapes (950 proved surfacing alone is insufficient).
  Complementary, not redundant.
- No change to anchoring/prune/sibling-survival/Steiner, the generator, the IR grammar, or the compiler's
  SQL emission. No new LLM calls.

## Consequences (pre-registered, calibrated)

- **Separable cases resolve deterministically:** 994-type `AGG` binds per-event; 892-type `MAX` binds
  standings — regardless of LLM run-to-run variance. (Verified live: the `total championship points by
  season` payload, which carries `constructorresults`/`constructorstandings` points siblings, resolves a
  cumulative mis-pick to the per-event sibling and compiles, where it previously failed
  `temporality-unreachable`.)
- **869 AND 950 correctly NOT resolved:** both `ASOF` → `grainAmbiguous`, nothing picked. Success = the
  flag is raised, not that either is "won" — the H4-boundary contribution.
- **EA:** modest (+1–3) on separable cases; the headline is **determinism** (removes the grain coin-flip
  for separable shapes) + the **honest ambiguity flag** for tier 3. Frozen-IR A/B (operation fixed,
  resolver on/off) isolates it from LLM noise.
- **Cross-domain:** the rule uses only IR operation structure + generated temporality tags + FK-symmetry
  — no F1 strings. `AGG-over-events ⇒ per-event` holds for any cumulative-vs-per-event sibling pair in any
  domain (proved by a synthetic non-F1 `rank` test); the ASOF collision is a general irreducibility.

## Logged follow-up (not fixed here)

The monotonicity probe mistags constant columns: `qualifying.number` is constant-per-season ⇒ trivially
non-decreasing ⇒ tagged `cumulative-snapshot` in the committed fixture (ADR-015 dodged it for the
snapshot probe via functional determination, but the latent mistag remains). Follow-up: a
strict-increase / move-floor guard on the monotonicity probe ([`monotonicity.ts`](../../src/profiling/monotonicity.ts)).

## Prior art

- **OntoKG (arXiv 2604.02618).** A property's declared facet (here temporal grain), emitted by the
  generator and **consumed downstream** by a deterministic step — we consume the grain facet at binding.
- **AmbiSQL / single-candidate guard.** When two candidates both bind validly and structure does not
  separate them, treat it as a clarify-point (here: surface `grainAmbiguous`) rather than a deterministic
  pick — the honest handling of irreducible ambiguity.

Cites the [grain-separability diagnostic](../diagnosis/grain-separability.md) and composes with
ADR-012/013/014/015.
