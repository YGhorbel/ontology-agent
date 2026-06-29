# ADR-014 — Keep FK-symmetric grain-competitor siblings in the candidate set

**Status:** accepted · **Stage:** 1.6 (between the S1.5 prune and S2 Steiner routing) · **Refines
[ADR-008](008-semantic-pruning.md)** · **Activates [ADR-013](013-menu-grain-distinguishers.md)** ·
**Composes with [ADR-009](009-steiner-tiebreak.md), [ADR-012](012-from-back-prune.md)**

## Context

After Move 1 (ADR-013) surfaced column grain in the menu, the grain-retrieval-survival diagnostic
([docs/diagnosis/grain-retrieval-survival.md](../diagnosis/grain-retrieval-survival.md)) found Move 1
has **zero live dividend**: in no benchmark case do the two competing same-name columns reach the
payload together (zero BOTH-PRESENT cases). The dominant grain failure is one layer earlier —
**TABLE-DROP:S2**: the correct fact table is anchored but the **S1.5 specificity prune drops it because
an FK-symmetric sibling survives instead.**

`constructorresults` and `constructorstandings` each declare exactly **one** FK → `constructors`
(identical declared shape). So:

- the Steiner cost→cardinality tie-break ([ADR-009](009-steiner-tiebreak.md)) sees identical cost and
  cannot separate them, and
- the specificity prune ([ADR-008](008-semantic-pruning.md)) picks the survivor by anchor-provenance,
  which is **grain-blind**.

950 ("constructors with 0 points") and 994 ("constructor most points, Monaco") are **mirror images**:
950 keeps `constructorresults` and drops `constructorstandings` (the gold); 994 does the exact reverse.
That mirror is the proof — the survivor is a **coin-flip**, not a principled choice.

## The framework (why retrieval, not ranking)

This is the **candidate-generation / candidate-ranking** split from entity-linking. The field's iron
law: *if the correct candidate is absent from the set, no ranker can recover it* — recall at the
generation stage caps everything downstream. Move 1 is the **ranker** (it tags grain in the menu); the
diagnostic proved it is **dormant** because the competing siblings never co-occur in the payload for it
to rank. MEDTYPE (coarse semantic-type filtering) shows coarse-type retention captures most of the
disambiguation gain — here `qsl:temporality` is the coarse grain-type. UniSAr / Move 1 is the surfaced
distinguisher. So: **fix retrieval first** — keep both siblings, tagged by grain — and let the planner
choose.

## Decision — Route A (keep both, let the tagged menu choose)

Retain FK-symmetric grain-competitor siblings in the candidate set instead of letting the prune keep
one by grain-blind specificity. We deliberately do **not** move the grain choice into the prune as a
deterministic rule ("if the question says cumulative, prefer the tagged column" — **Route B**): that
risks domain-specific heuristics and forecloses the falsifiable test of whether *surfacing* grain is
sufficient. Route A keeps the choice at the planner, surfaced by the ontology.

### The trigger (narrow — computed from graph structure + anchored columns; no hardcoded names)

Two candidate terminals `a`, `b` are FK-symmetric grain-competitor siblings iff **all three** hold:

1. **Declared-FK symmetry.** `declNeighbours(a) \ {b} == declNeighbours(b) \ {a}`, where
   `declNeighbours` counts only `provenance === 'declared'` edges. **Declared-only is load-bearing:**
   the profiled graph adds *discovered/inferred-name* fact-to-fact edges (e.g.
   `constructorresults`↔`constructorstandings` via `constructorid;raceid`, and `constructorstandings`→
   `qualifying`/`results`) that are asymmetric and would defeat the test. The diagnostic's "identical
   FK shape" is precisely the **declared-dimension-join** shape.
2. **Shared anchored, NON-KEY same-name column.** A column anchored on both, present on both nodes, and
   **not a join key** (PK ∪ any column appearing in a join edge's `columnPairs`). This keeps genuine
   measures (`points`, `time`) and excludes anchored join keys (`constructorid`, `raceid`, `driverid`)
   — the difference between a *grain competitor* and a merely *structurally parallel* table.
3. **Narrowing gate — ≥1 member survived the prune.** We only *un-break a coin-flip* among a group the
   prune already admitted; we never re-introduce a group the prune fully rejected (that would re-open
   the over-join ADR-008 just fixed).

Members of every firing component (size ≥2, ≥1 kept) are retained. Implemented as the pure,
deterministic `rescueFkSymmetricSiblings` ([src/query/sibling-survival.ts](../../src/query/sibling-survival.ts)),
invoked from `subgraphNode` after `deriveAnchoredColumns` and before Steiner routing.

## Composition

- **Move 1 (ADR-013):** with both siblings retained as terminals, `trimColumns` keeps each one's
  anchored `points` (+ `temporality` + samples), so the menu shows
  `constructorstandings.points [cumulative snapshot]` **and** `constructorresults.points` side by side
  — the BOTH-PRESENT state Move 1 was waiting on. The two bricks compose: sibling-survival is the
  retrieval layer; Move 1 is the ranker.
- **Back-prune (ADR-012):** keeping both adds a table, but the planner references only one; the
  unreferenced sibling is an FK-symmetric **degree-1 leaf** (both hang off the shared bridge
  `constructors`), so leaf-pruning drops it from FROM. Keeping both **never re-introduces an over-join**
  — verified: in the 950 and 994 payloads both siblings are degree-1.

## Verified fire-set (sanity-list over the committed fixture)

| case | gold | fires? | rescues | unblocks gold? |
|---|---|---|---|---|
| **950** | `constructorstandings.points` | ✓ | constructorstandings | **YES** |
| **994** | `constructorresults.points` | ✓ | constructorresults | **YES** |
| 937 | `results.time` | ✓ | laptimes | no — `results` declares an extra `status` FK ⇒ never FK-symmetric to its survivors (`laptimes`/`pitstops`); the `{laptimes,pitstops}` pair fires harmlessly (back-prune drops the unreferenced one) but does not reach `results` |
| 892 | `driverstandings.points` | ✗ | — | no sibling (only declared-`{drivers}` fact among candidates) |
| 906 | `driverstandings.points` | ✗ | — | gate-3 (the pair exists but neither survived the prune) |
| 928 / 989 / 990 / 933 | `results.*` | ✗ | — | predicate / concept-owns-table (the later brick); or gate-3 |
| 902 | `driverstandings.position` | ✗ | — | S1 miss (never anchored) |

## Consequences

- **Pre-registered (calibrated to the sanity-list):** 2 clean retrieval-unblocks (950, 994) reaching
  the BOTH-PRESENT payload; realistic match-flips ≈ 1–2 (994 also fails in the compiler with
  `predictedSql=null`; 906/892 are suspect-gold and out of scope). The headline value is
  **infrastructural** — it removes the grain-sibling lottery so Move 1 and the predicate work (933)
  become measurable in isolation. We do **not** claim the diagnostic's headline "8".
- **The trigger sorts the buckets:** grain-competitor siblings are rescued; predicate /
  concept-owns-table cases (results.rank/.time/.positionOrder) are correctly left untouched for the
  later predicate/status-join brick. The `results`-family does not fire because `results` declares a
  richer FK shape (`+status`) than its candidate siblings — a finding, not a gap.
- **Falsifiable test:** with both tagged siblings visible, does the planner pick the right grain for
  950/994? If it persistently mis-picks with both visible, that result justifies a deterministic
  selector (Route B) next — to be recorded honestly, not papered over.

## References

Entity-linking candidate-generation recall principle; MEDTYPE semantic-type filtering; UniSAr / Move 1
(ADR-013) for the surfaced distinguisher. Diagnostic:
[grain-retrieval-survival.md](../diagnosis/grain-retrieval-survival.md).
