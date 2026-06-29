# Grain retrieval-survival — which layer is each grain case blocked on?

**Status:** analysis only. No code, no pipeline changes. Reconstructed from a **live S1→S2
trace** (`scripts/grain-trace.ts`, read-only: anchor → prune → superlative → subgraph, no
LLM, no DB) cross-checked against `eval/results/benchmark-1782511248.json`. Gold SQL is used
**only** to identify the correct target table+column — nothing is tuned to gold.

Purpose: before building the next retrieval brick, partition every grain-bucket question by
**the pipeline layer at which the correct distinguishing candidate is lost**, size the
expected lift of each candidate brick, and find any cases the just-shipped menu grain tag
(Move 1 / [ADR-013](../adr/013-menu-grain-distinguishers.md)) already unblocks.

## Method

For each case: (A) read the gold SQL for the correct-grain **table.column** the answer needs;
(B) run S1→S2 and capture the anchor set, the **pruned terminals**, the **anchoredColumns**
map, and the **per-table columns retained in the payload** (the signal the benchmark JSON
lacks); (C) classify into exactly one bucket; (D) for table-drops, record the wrong-grain
sibling the subgraph kept instead and whether it has the **same FK shape** (the zero-cost
symmetry that defeats Steiner's cost tie-break).

The three buckets (where the correct candidate dies):

- **BOTH-PRESENT (menu layer — Move 1 helps):** correct table in payload, correct column
  retained, **and** the competing same-name column also present → the grain tag can now choose.
- **COLUMN-TRIM (column-selection fix):** correct table in payload but correct column **trimmed**.
- **TABLE-DROP (subgraph/anchoring fix):** correct table **not** in payload. Sub-classified
  `:S1` (never anchored) vs `:S2` (anchored, dropped by the S1.5 prune / Steiner keeping a sibling).

## Per-case table

| id | question (short) | gold table.col (correct) | in payload? | col retained? | competing col present? | BUCKET | sibling kept | same FK? |
|---|---|---|---|---|---|---|---|---|
| 854 | coordinates of Australian GP circuit | `circuits.lat,lng` | **yes** (circuits) | **no** (lat/lng trimmed) | yes (`location`) | **column-trim** | — | — |
| 868 | Malaysian GP location coordinates | `circuits.lat,lng` | **yes** | **no** | yes (`location`,`country`) | **column-trim** | — | — |
| 910 | Silverstone location coordinates | `circuits.lat,lng` | **yes** | **no** | yes (`location`) | **column-trim** | — | — |
| 950 | constructors with 0 points at race 291 | `constructorstandings.points` | **no** | — | `constructorresults.points` (wrong grain) | **table-drop:S2** | constructorresults | **yes** |
| 994 | constructor most points Monaco '80–'10 | `constructorresults.points` (SUM) | **no** | — | `constructorstandings.points` | **table-drop:S2** | constructorstandings | **yes** |
| 892 | driver with most points (full name) | `driverstandings.points` | **no** | — | none — all fact tables pruned | **table-drop:S2** | none (drivers-only) | n/a · *suspect-gold* |
| 902 | Alex Yoong race, "track number" < 20 | `driverstandings.position` | **no** | — | none (col never anchored) | **table-drop:S1** | — | *ambiguous gold* |
| 906 | Lewis Hamilton first race + points | `driverstandings.points` | **no** | — | none (pitstops kept) | **table-drop:S2** | pitstops | **yes** · *suspect-gold* |
| 928 | driver ranked first, Canadian GP 2007 | `results.rank` | **no** | — | planner used `qualifying.q1` | **table-drop:S2** *(was 2b)* | qualifying/laptimes | **yes** |
| 933 | Lewis final rank, 2008 Chinese GP | `results.positionOrder` | **yes** (results) | **yes** (`positionorder` kept) | `results.position` also present | **2b-predicate** | — | — |
| 937 | finish time of 2nd-ranked, 2008 Chinese GP | `results.time,rank` | **no** | — | pitstops kept | **table-drop:S2** *(was 2b)* | pitstops | **yes** |
| 989 | champion Canadian GP 2008, finish time | `results.time` | **no** | — | laptimes kept | **table-drop:S2** *(was 2b)* | laptimes | **yes** |
| 990 | champion constructor ref + url, Singapore '09 | `results.time` (predicate) · `constructors.ref,url` (proj) | proj **yes** / results **no** | proj retained; `results` absent | — | **table-drop:S2** *(was 2b)* | qualifying | **yes** (proj cols present) |

## Partition counts

| bucket | ids | count |
|---|---|---|
| **BOTH-PRESENT** (Move-1 dividend) | — | **0** |
| **COLUMN-TRIM** | 854, 868, 910 | **3** |
| **TABLE-DROP:S2** (anchored, prune/Steiner kept a sibling) | 950, 994, 892, 906, 928, 937, 989, 990 | **8** |
| **TABLE-DROP:S1** (never anchored) | 902 | **1** |
| **2b-predicate** (concept-owns-table, table+col present) | 933 | **1** |

**Cross-check — same-FK-shape siblings (the symmetry that defeats cost):** **7** of the 9
table-drops (950, 994, 906, 928, 937, 989, 990) lost the correct table to a sibling that
**joins the exact same neighbours** — `constructorresults`↔`constructorstandings` (both
`constructors`+`races`), `pitstops`/`results`/`laptimes`/`qualifying`/`driverstandings` (all
`races`+`drivers`(+`constructors`)). Identical FK shape ⇒ identical Steiner cost ⇒ the
minimum-cost-then-min-cardinality tie-break ([ADR-009](../adr/009-steiner-tiebreak.md))
cannot tell them apart, and the S1.5 prune ([ADR-008](../adr/008-semantic-pruning.md))
picks the survivor by **anchor-provenance specificity**, which is grain-blind. (892 lost
*all* fact tables — prune over-aggression, no sibling; 902 is the S1-miss.)

## The Move-1 dividend is **empty** — and that is the finding

**Zero** grain cases are BOTH-PRESENT. In no case do both competing same-name columns reach
the payload together: 950 carries `constructorresults.points` but **not** `constructorstandings`;
994 carries `constructorstandings.points[cumulative-snapshot]` but **not** `constructorresults`.
The temporality tag *does* fire (the trace shows `points[cumulative-snapshot]` rendered on
994's `constructorstandings`), but there is **no per-event sibling in the same payload to
disambiguate against** — and worse, in 994 the only points column present is the *wrong-grain*
one, so the tag can at best tell the planner "this is cumulative," not route it to the
per-event column it can't see.

> **Move 1 (ADR-013) shipped correctly but has no live dividend in the current benchmark.**
> Its value is **entirely gated** on the retrieval fix below. This matches the "Retrieval
> caveat" ADR-013 already flagged for 950 — it turns out to hold for the *whole* 2a/2c family,
> not just 950.

## 2b confirmation — most of "2b" is secretly a retrieval failure

ADR-013 deferred 2b (928, 933, 937, 989, 990) as "concept-owns-table → predicate/status-join,
not retrieval." The trace **overturns** that for 4 of the 5:

- **933 — genuinely concept-owns-table.** `results` *is* in the payload **and** `positionorder`
  *is* retained alongside `position`; the planner picked `position` over `positionorder`. A true
  predicate/encoding problem (and **not** a temporality case — the menu grain tag does not apply
  to `position` vs `positionorder`). Stays 2b.
- **928, 937, 989 — retrieval failures.** `results` (which owns `rank`/`time`) was anchored but
  **pruned**, and an FK-symmetric sibling (`qualifying`/`laptimes`/`pitstops`) survived. The
  predicate can never fire because the table that carries it never reaches the planner. **Moved
  to table-drop:S2.**
- **990 — retrieval failure on the discriminating table.** Projection columns
  (`constructors.constructorref`,`url`) *are* present, but the "champion" predicate needs
  `results.time`, and `results` was pruned. **Moved to table-drop:S2.**

So the 2b bucket collapses from 5 → **1** genuine predicate case (933); the other 4 join the
dominant table-drop bucket.

## Decision & next brick

**TABLE-DROP:S2 dominates — 8 of 13 cases (and 7 of those are FK-symmetric sibling swaps).**
The next brick is therefore **sibling-survival in the subgraph candidate set**, not column
retention:

> **When two (or more) FK-symmetric fact-table siblings are both anchored, keep *both* in the
> payload** (the prune must stop choosing one by grain-blind specificity), **or** move the
> grain choice earlier by letting `qsl:temporality` break the tie at prune time. Keeping both
> is the cleaner first cut because it *also activates Move 1*: with `constructorresults.points`
> and `constructorstandings.points[cumulative-snapshot]` side-by-side in the menu, the grain
> tag finally has something to choose between. The two bricks **compose** — sibling-survival is
> the retrieval layer Move 1 was always waiting on.

**Pre-registered expected lift (the count that the re-benchmark confirms):**

- **Retrieval-unblock: 8** (the table-drop:S2 set) — the correct table reaches the payload.
- **Realistic match-flips: ≈ 3–5.** As with the over-join split, retrieval-correct ≠ match —
  892 and 906 are *suspect-gold*, 994 also dies in the compiler (`predictedSql=null`), and
  several carry co-occurring defects (wrong projection, dropped filter). The brick's headline
  value is **infrastructural**: it removes the grain-sibling lottery so Move 1 and the predicate
  work (933) become measurable in isolation.

**Secondary brick — column-retention / column-first linking: 3** (854, 868, 910). All three
are the identical `coordinates → lat,lng` failure: `circuits.lat`/`lng` **exist in the ontology**
but the trimmer keeps only join-keys + anchored + sampled columns, and "coordinates"/"location"
anchors to `circuits.location` (numeric `lat`/`lng` are never anchored and carry no sample
values). Clean lift (no suspect gold), but smaller and independent of the dominant problem —
schedule it **after** sibling-survival.

**Do not rebuild Move 1.** It is correct; it is dormant. Confirm its dividend appears in the
re-benchmark *after* sibling-survival lands.
