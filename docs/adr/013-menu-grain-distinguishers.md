# ADR-013 — Surface column grain (temporality) in the planner menu

**Status:** accepted · **Stage:** 3a (LLM planner menu) · **Refines [ADR-010](010-planner-menu-semantics.md)**

## Context

After back-prune ([ADR-012](012-from-back-prune.md)), the largest correctable failure bucket is the
**grain / wrong-fact-table** family (~12–15 questions; e.g. 950, 892, 902, 906, 994 and 854, 868, 910).
The diagnosis is **not** "the planner saw both candidates and chose the wrong one." It is that the
planner is **blind to grain**: the ontology *generates* the distinguishers, but the pipeline drops them
before the menu the LLM reads.

Two same-surface-name columns make this concrete:

- `constructorresults.points` — `rdfs:comment` = "Points awarded … (per-row value, not a running total)".
- `constructorstandings.points` — `qsl:temporality` = `"cumulative-snapshot"` + `rdfs:comment` =
  "Running total (cumulative) … not points awarded solely at that race".

A Step-0 survival trace established what survives each pipeline boundary:

| Signal | JSON-LD | In-memory model | Menu (LLM input, before this ADR) |
|---|---|---|---|
| `qsl:temporality` | present | carried → `ColumnProp.temporality` (`columnPropOf`, graph-build.ts), survives the Stage-2 trimmer (`trimColumns` spreads all fields) | **not rendered** — `renderPropLine` had no code for it |
| `rdfs:comment` | present | carried → `ColumnProp.description` | rendered (ADR-010) but char-capped at `QUERY_MENU_DESC_CAP` (160) |

So the model **already carried** `temporality`; the only gap was the menu line. The fix is therefore a
**renderer-only** change — not a graph-model carry.

## Decision

In `renderPayloadMenu` / `renderPropLine` ([src/prompts/planner.ts](../../src/prompts/planner.ts)),
append a **grain tag** to a terminal column's menu line when it carries `qsl:temporality`:

```
- constructorstandings.points — IRI: … — "Constructor points" [cumulative snapshot] — Running total (cumulative) … not points awarded solely at that race …
- constructorresults.points  — IRI: … — "Points"             — Points awarded … (per-row value, not a running total) …
```

The tag is rendered **generically** — `[${temporality.replace(/-/g, ' ')}]` — from whatever value the
ontology carries, so it disambiguates same-name columns for **any** DB with **no hardcoded strings**. It
renders only for **terminal** (selection-target) columns (bridge columns stay terse, mirroring how the
description is gated), and it adds **no IRI**, so **menu == leash** is preserved (`payloadIris` unchanged).

The `QUERY_MENU_DESC_CAP` (160) is **kept unchanged**: the survival check confirmed the distinguishing
clause of every 950-family comment fits within 160 (~151 chars), so the part that distinguishes per-row
from cumulative reaches the model intact (test `D3`). Bump it only if a future fixture shows truncation.

## Measured hypothesis & scope

The brick is measured against the **blind-to-grain** hypothesis: surfacing the distinguisher should help

- **2a** (cumulative-vs-per-event: 950, 892, 902, 906, 994), and
- **2c** (projection: 854, 868, 910).

It is **not** expected to flip **2b** (concept-owns-table: 928, 933, 937, 989, 990 —
"rank"/"finished"/"champion"), which needs predicate/status-join work (a later brick).

The deliverable is **the grain signal is now in the menu** — the execution-accuracy effect is measured
separately (frozen-IR A/B preferred, to remove the LLM confound). A planner that still mis-picks with a
visible `[cumulative snapshot]` tag is the empirical result that would justify a heavier deterministic
selector next; that outcome is to be recorded, not papered over.

**Retrieval caveat (separate layer).** A menu distinguisher can only help when *both* candidate columns
reach the payload. For 950 specifically, an earlier benchmark trace showed `constructorstandings` did
**not** reach the payload (it carried `constructorresults`/`constructors`/`qualifying`/`races`). If that
still holds, 950 is blocked at the **retrieval** layer, not the menu — a distinct next question, not a
failure of this brick. The unit tests isolate the menu by constructing a payload where both candidates
are present.

### Deferred: per-edge join fan-out

Surfacing the per-edge **fan-out / cardinality** signal on `SubgraphPayload.joins` is **deferred** to a
follow-up brick. The Step-0 trace corrected the original premise that it was a simple "un-trim":

- The `multiplies` flag (`join-graph.ts`, `clauseMultiplies`) lives in a **separate module**
  (`GraphEdge`/`JoinClause` from `types/query-plan.ts`, used by grounding/intent/CLIs) — **not** the
  Stage-2→planner path.
- The planner-facing `SubgraphPayload.joins` is built in `subgraph.ts` from `graph-model.ts`'s `JoinEdge`,
  which has **no cardinality field**, and the builder (`graph-build.ts`) **never reads `qsl:cardinality`**.
  So this is a real cross-file carry (ontology → `JoinEdge` → payload → renderer), not an un-trim.
- The formula1 fixture's FK edges are **28 many-to-one + 1 many-to-many, zero one-to-many**; under the
  intended rule (a row-multiplying hop = the joined-in side is "many"), the annotation **could not fire**
  on the live demo. The carry is therefore best validated in its own brick with a synthetic one-to-many.

## Prior art

This is the schema-property-enrichment pattern from **UniSAr** — type/cardinality/description enrich the
schema representation and disambiguate same-surface-name columns — here driven by *profiled* evidence
(`qsl:temporality` / `qsl:temporalityEvidence`).

## Consequences

- The planner menu now distinguishes cumulative from per-row columns with a one-token tag plus the
  surviving description clause; the signal the generator wrote finally reaches the decision point.
- No change to anchoring, pruning, Steiner routing, the IR grammar, or the compiler; menu == leash holds.
- Covered by tests `D1`–`D5` in [test/nodes/planner.test.ts](../../test/nodes/planner.test.ts), including
  a non-regression case (no temporality ⇒ no tag; numeric ranges not mistaken for tags) and a synthetic
  non-f1 generality case (proves no hardcoding).
