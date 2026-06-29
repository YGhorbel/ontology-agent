# Benchmark Pain-Point Diagnosis — formula1 / f1-draft

**Status:** analysis only. No code changed. Grounded in
`eval/results/benchmark-1782480844.json` (gitSha `49815c3`, model `gpt-5-mini`,
prompt `planner/v2`, 64 questions) and a direct read of the Stage-1→3b source.

**Headline result:** 8/64 raw (12.5%), 14.0% adjusted. Of the 56 non-match
questions, **39 (70%) produced a SQL whose table set is strictly larger than
gold's**, and **33 of those join through a row-population-changing fact table
that gold never touches.** Over-joining is confirmed as the dominant failure —
and it is fully decided *before the LLM runs*, by anchoring + pruning + Steiner.

---

## PART 1 — Architecture map

### Data-flow (where the table set / row population can change)

```
question ─► [S1 ANCHOR] ──terminals (≤8, recall-favoring)──►
            anchorQuestion()           conceptAnchors + valueAnchors
                                              │
                                              ▼
            [S1.5 PRUNE] ── drops terminals not "specifically grounded" (IDF rule) ─►
            pruneTerminals()           keptTerminals  ◄── can ONLY shrink the set
                                              │
            [S1.x SUPERLATIVE] ── adds 1 ranking COLUMN (never a table) ──┐
            groundSuperlatives()                                          │
                                              ▼                           │
            [S2 STEINER] ── cheapest tree over kept terminals; ADDS BRIDGE TABLES ─►
            extractSubgraph()          SubgraphPayload{classes, joins, …}
                                              │  ◄── the table set is now FROZEN
                                              ▼
            [S3a PLANNER LLM] ── chooses SELECT/measure/groupBy/filter/orderBy ONLY ─►
            planQuery()                MetricQueryIR   ◄── NO join authority
                                              │
                                              ▼
            [S3b COMPILE] ── emits EVERY payload.join verbatim into FROM ──►
            compile()                  SQL            ◄── cannot drop a payload table
                                              │
                                              ▼
            [EXECUTE] ── Postgres ──► rows
```

The single load-bearing fact for the rest of this document:

> **The FROM clause = the entire Steiner payload, always.** `buildFrom`
> ([compiler.ts:246](src/query/compiler.ts#L246)) iterates *all* `payload.joins`
> and emits each as an `INNER JOIN`. The IR grammar ([ir.ts:65](src/query/ir.ts#L65))
> has no join field; the planner ([planner.ts](src/query/planner.ts)) is told
> "you do NOT choose joins." So **any table that survives into the payload becomes
> an inner join that constrains the row population — whether or not the plan ever
> references it.** Population is fixed before the LLM is invoked.

### Per-stage detail

| Stage | File | In → Out | Decides | Can ADD tables? | Can DROP tables? | Knobs (defaults) |
|---|---|---|---|---|---|---|
| **Anchor** | [anchor.ts](src/query/anchor.ts) | question → `AnchorSet{terminals, conceptAnchors, valueAnchors}` | which class IRIs are candidate terminals, by lexical concept-match (FLOOR 0.6) ∪ value-match (VALUE_SCORE 0.95, fuzzy 0.82) | **YES** — recall-favoring, over-returns | no | `maxTerminals 8`, `fuzzyThreshold 0.82`, `FLOOR 0.6`, `COMMENT_SCORE 0.72`, `FUZZY_MIN_LEN 4` |
| **Anchor-index** | [anchor-index.ts](src/query/anchor-index.ts) | ontology → concept/value indexes | static label + sample-value dictionaries (no DB, no embeddings) | — | — | — |
| **Anchor-model** | [anchor-model.ts](src/query/anchor-model.ts) | (types) | `AnchorSet`/`SuperlativeDirective` contracts | — | — | — |
| **Prune** | [prune.ts](src/query/prune.ts) | `AnchorSet` → `kept terminals` + `PruneTrace` | keep a terminal iff (1) exact class anchor (score≥1.0), (2) a value anchor classes to it, or (3) a **specific** keyword grounds it (document-freq `df ≤ keywordDf`) | no | **YES** — only place the terminal set shrinks | `QUERY_PRUNE_KEYWORD_DF 2`, `classExact 1.0`; empty-set fallback keeps best-scored 1 |
| **Superlative** | [superlative.ts](src/query/superlative.ts) | (question, kept terminals, graph) → `SuperlativeDirective[]` | bind a date superlative to the *single* orderable date column on a class (id-like excluded); merged into `anchoredColumns` | no (columns only) | no | lexicon: oldest/earliest/youngest/newest/latest; `DATE_TYPES`; numeric reserved |
| **Steiner** | [subgraph.ts](src/query/subgraph.ts) | (graph, kept terminals, capabilities) → `SubgraphPayload` | cheapest tree connecting terminals (metric-closure MST 2-approx); trims columns; lists capabilities scoped to tree nodes | **YES** — adds **bridge** classes on the connecting path | only incidental-leaf pruning | edge cost from graph-build; tie-break cost→minConf→hops→comps→lexicographic; `MAX_SAMPLE_VALUES 15` |
| **Graph-build** | [graph-build.ts](src/query/graph-build.ts) | ontology JSON-LD → `OntologyGraph` | edge weight = `max(1−confidence, tierFloor)`; drops junctions; composite FK = 1 edge | — | — | `QUERY_EXPORT_MIN_CONF 0.5`, `floorDeclared 0`, `QUERY_EDGE_FLOOR_DISCOVERED 0.02`, `QUERY_EDGE_FLOOR_NAME 0.3` |
| **Planner** | [planner.ts](src/query/planner.ts) + [prompts/planner.ts](src/prompts/planner.ts) | (question, payload) → `MetricQueryIR` | the query SHAPE (projection / ranking / aggregation) + SELECT / measures / groupBy / filters / orderBy / limit | no (leash rejects out-of-payload IRIs) | no | `maxRetries 2` (3 attempts); `QUERY_MENU_DESC_CAP 160`; `SAMPLE_CAP 15` |
| **IR** | [ir.ts](src/query/ir.ts) | (schema) | shape XOR (`select` xor `measures`); value-grounding of enum filter literals (`=`/`!=`/`IN`) | — | — | `OPTION_POOL_CAP 15`; `VALUE_GROUNDED_OPS {=,!=,IN}` |
| **Compile** | [compiler.ts](src/query/compiler.ts) | (IR, payload) → SQL | renders SELECT/FROM/WHERE/GROUP/ORDER; **emits every payload join**; H2 temporality de-cumulation; numeric-text cast | **effectively** — joins every payload table | **no** | `NUMERIC_FNS`, `NUMERIC_COMPARE_OPS` |
| **Pipeline** | [pipeline.ts](src/query/pipeline.ts) | question → `PipelineResult` | wires S1→S2→S3a→S3b→execute; failure routing to END; `deriveAnchoredColumns` seam | — | — | — |

---

## PART 2 — Over-joining traced to its SOURCE

### Method

For every failure I compared `traceSummary.payloadTables` (the tables that became
the FROM clause) against the table set parsed from `goldSql`, and split the
payload tables into **kept terminals** (`traceSummary.terminalsKept`) vs **bridges**
(payload − terminals). "Population table" = a fact table whose inner join changes
the answer's row population: `laptimes, qualifying, pitstops, results,
driverStandings, constructorResults, constructorStandings`.

### Findings (counts over the 64-question run)

- **39/56 failures over-join** (payload table set strictly ⊃ gold's).
- **33/39 join through a population fact table gold never uses** — the genuine
  corruption. (The other 6 — 846, 861, 872, 910, 945, 978 — over-join only on
  `races`/`circuits` via an FK that does *not* change population; their real
  defect is a wrong column or a dropped filter, not the join.)
- **Every single over-join case has ≥1 extra TERMINAL** (a kept class gold didn't
  need). There is **no** case of "correct terminals, bad bridge only."
- **~19/33** *additionally* route the population table in as a **Steiner bridge**
  (laptimes/qualifying hub); the rest carry it as a kept terminal.
- The 3 fan-out **execute-errors** (879, 959, 972) are over-joining taken to its
  limit: joining `drivers`–`laptimes`–`pitstops`–`results` on the shared
  `driverid` produces a near-Cartesian blow-up (cf. q880 returned **30,613,830**
  rows from the same join shape) → the query errors/explodes.

### Stage attribution

| Stage | Role in over-joining | Share |
|---|---|---|
| **Anchor** | **Originator.** Recall-favoring union over-returns terminal classes. Every over-join begins with a class anchored that the answer does not need (e.g. `circuits` from "country", `constructors` from "constructor", `drivers`/`qualifying`/`pitstops` from the FK-key keyword "driver"). | **~100% (necessary trigger)** |
| **Prune** | **Failed gatekeeper.** It is the only stage that can shrink the set, and it keeps these classes: the IDF rule keeps any terminal grounded by a `df ≤ 2` keyword, and the over-anchored classes are each grounded by a specific word (`country`→`circuits.country`, `constructor`→`constructors`). Calibrated for recall, it under-fires on precision. | co-owns the trigger |
| **Steiner** | **Amplifier.** Given an extra terminal, it must connect it, and on formula1 it routes through a population hub (`laptimes`/`qualifying`) at near-zero cost. Turns an extra *terminal* into a population-corrupting *bridge*. | ~50% (amplifies) |
| **Compiler** | **Silent executor.** Emits *every* payload join as INNER JOIN regardless of whether the IR uses it, so even an unreferenced bridge constrains the population (and fan-out-explodes). | mechanism, not chooser |
| **Planner** | **Not at fault.** No join authority; cannot add or drop a table. | 0% |

**Verdict:** over-joining originates **~100% at anchoring (low precision)**, is
**not corrected at pruning (under-fires)**, and is **amplified to population
corruption at Steiner (~50%)** by formula1's cheap connectivity. The compiler
makes it lethal by joining unreferenced tables; the planner is blameless.

### Worked traces

- **915 "Which country is the oldest driver from?"** — gold: single table
  `drivers`. Anchor returns `{drivers, circuits}` (`circuits` from "country"
  → `circuits.country`). Prune keeps `circuits` (clause 3: "country" is df-specific).
  Steiner connects `circuits`↔`drivers` via bridges `races`+`laptimes`. The
  `laptimes` INNER JOIN restricts the population to drivers who have lap-time rows
  → "oldest" resolves to an Italian (modern era) instead of gold's French driver
  (pre-telemetry, no laptimes). **Source: anchor (extra terminal `circuits`) →
  Steiner bridge (`laptimes` restricts population).**
- **964 "codes for drivers with nationality American"** — gold: single table
  `drivers`, 157 rows. Anchor adds `constructors` (keyword "constructor"? — more
  precisely the value/concept channel), kept by prune; Steiner bridges
  `drivers`↔`constructors` through `qualifying`. The `qualifying` INNER JOIN
  collapses 157 → 2 (only drivers who ever qualified, deduped). **Source: extra
  terminal `constructors` → bridge `qualifying` changes population.**
- **854 / 868 "coordinates of the … Grand Prix"** — gold: `circuits ⋈ races`.
  Anchor over-returns `drivers`+`constructors`; Steiner must bridge them in via
  `laptimes`+`qualifying`. 854 returns **0 rows** (the long chain + name filter
  is empty); 868 returns a wrong column off the still-corrupted shape. **Source:
  extra terminals `drivers`/`constructors` → population bridges.**
- **950 "constructor names with 0 points at race 291"** — filters are correctly
  carried (`points=0 AND raceId=291`), but the payload routes through
  `constructorResults` (+ bridge `qualifying`) whereas gold uses
  `constructorStandings`. Wrong fact table → wrong population (7 rows vs 6).
  **Source: anchor/Steiner picked the wrong population table; the planner cannot
  override it.** (This is the deeper "wrong-grain" variant; back-pruning will not
  fix it because the table is referenced.)

---

## PART 3 — Ranked root-cause catalog

Buckets are by **root cause**, not symptom. "Cost" = questions whose failure is
primarily owned by this bucket (a question is charged once, to its dominant cause).
G = general, F1 = formula1-specific artifact.

| # | Bucket | Cost (≈) | G / F1 | Owning stage | One-line general fix hypothesis |
|---|---|---|---|---|---|
| 1 | **Over-join: population-changing join** (incl. 3 fan-out execute-errors) | **~36** | **G mechanism, F1-amplified** | anchor → prune → Steiner; compiler joins-all | After planning, recompile FROM as the **minimal subtree spanning only IR-referenced tables** — drop unreferenced bridges. |
| 2 | **Wrong population/grain table chosen** (results vs laptimes; constructorStandings vs constructorResults; driverStandings) | ~10 (subset of the over-join rows, but distinct fix) | **G** | anchor/Steiner (no grain awareness) | Cardinality/grain-aware retrieval: prefer the fact table whose grain matches the question's counting unit; penalize joining two sibling fact tables on a shared FK. |
| 3 | **Semantic predicate not linked to a column condition** ("finished"→`time IS NOT NULL`, "champion"/"rank 1st"→`rank=1`/`positionOrder=1`/`time LIKE '_:%:__.___'`, "disqualified"→`statusId`, "not finished"→`time IS NULL`) | ~8 (862, 865, 877, 881, 928, 933✓, 940, 954, 962, 977, 989, 990) | **G** | planner (+ table must be present) | Surface status/flag-column semantics in the menu and teach the planner an "implicit predicate" step; requires the owning table (`results`) to actually be in the payload. |
| 4 | **Wrong-column projection** ("coordinates"→`location`/`url` instead of `lat,lng`) | ~4 (857, 868, 910, 854) | **G** | planner (schema-linking) | Disambiguate projection columns from column semantics (prefLabel/description), not lexical surface; "coordinates" must bind the lat/lng pair. |
| 5 | **Self-produced execute-errors** | 4 (879, 959, 972 = fan-out; 884 = date/format) | **G** | compiler robustness / over-join | 879/959/972 are bucket-1 fan-out (same fix). 884: a date-cast/aggregate-shape the compiler emitted invalidly → compiler robustness + IR date handling. |
| 6 | **Aggregate-then-rank / capability gap** | 2 (892, 994) | **G** | IR / capability resolution | 892: a capability with no `formulaHint` reached the compiler (`capability-no-formula`); guard + fall back to ad-hoc aggExpr. 994: expressible but planner failed the leash on a 7-table over-joined payload → downstream of bucket 1. |
| 7 | **Time-string literal/format mismatch** (`q3 = '0:01:54'` vs stored `1:54.xxx`) | ~3 (861, 866, 872) | **G mechanism, F1 format** | planner literal + value-grounding | Value-grounding no-ops on high-cardinality time columns, so the planner invents a format. General fix: ground/normalize literals against a column's *observed format*, or prefer `LIKE` for time-pattern columns. |
| 8 | **NULL-ordering / order-direction drift** (missing `NULLS FIRST/LAST`; `dob`/text sort) | ~2 net (mostly co-occurring, rarely the *sole* cause) | mixed (G mechanism; some are suspect-gold) | planner orderBy / compiler | Default NULL placement per direction; but several flagged cases are `suspectGold` and shouldn't be chased. |
| 9 | **Benign over-join (wrong column / dropped filter underneath)** | 6 (846, 861, 872, 910, 945, 978) | G | various | Each resolves under bucket 3/4; the extra `races`/`circuits` join is harmless. |

**Suspect-gold guard:** 7 questions are flagged `isSuspectGold` (846, 847, 879,
892, 906, 931, 944). They are excluded from the adjusted denominator and should
not drive fixes.

### Ranking by (accuracy cost × generality)

1. **Over-join population corruption (bucket 1)** — highest cost (~36 questions),
   general mechanism, single clean owner. **The next brick.**
2. **Wrong population/grain table (bucket 2)** — high cost, deeply general, but a
   harder retrieval problem (needs grain awareness, not just join trimming).
3. **Semantic-predicate linking (bucket 3)** — high cost, general, but blocked
   behind bucket 1/2 (the owning table must be in scope first).

---

## PART 4 — General-mechanism check (cross-domain guard) for the top 3

**Bucket 1 — minimal-subtree back-pruning of the FROM clause.**
*General mechanism:* after the planner emits the IR, collect the set of tables the
IR actually references (select / measures / groupBy / filters / orderBy property
IRIs). Recompute the FROM as the minimal connected subtree of the *existing
Steiner tree* that spans exactly those tables (a bridge stays only if it lies on a
path between two referenced tables). Drop every other table and its joins.
*Cross-domain?* **Yes — fully.** It is a pure graph operation over IRIs the plan
already produced. No hardcoded column names, no formula1 lexicon, no domain rules.
It would work on any schema and directly neutralizes the "compiler joins
everything" mechanism, eliminating unreferenced-bridge population corruption and
the fan-out execute-errors. *Limit:* it cannot fix a case where the *wrong* table
is referenced (bucket 2) — that table survives because the plan names it.

**Bucket 2 — grain/cardinality-aware retrieval.**
*General mechanism:* derive each table's grain (its key/uniqueness, already profiled
as `isPrimaryKey`/`observedUnique` in `ColumnProp`) and (a) prefer the fact table
whose grain matches the question's counting/answer unit, (b) add a Steiner cost
penalty for traversing *into* a second many-rows fact table off a shared FK.
*Cross-domain?* **Mostly.** Grain is derivable from profiling we already have, and
"don't fan-out across two sibling fact tables on the same key" is schema-agnostic.
The risk: "which fact table matches the answer unit" edges toward schema-linking
and could tempt a formula1 patch (e.g. hardcoding `results` as the canonical
driver-per-race grain). **Flag:** if the only working fix turns out to be "map
'finished/rank/points/champion' → results," that is a formula1 patch — do not take
it; it means bucket 2 is really a general schema-linking problem we should name as
such, not solve locally.

**Bucket 3 — semantic-predicate linking.**
*General mechanism:* surface status/flag column semantics (prefLabel/description/
sample values) in the planner menu — already partly done by ADR-010 — and let the
planner translate a predicate phrase into a column condition. *Cross-domain?*
**The mechanism is general, the knowledge is not free.** "finished = time IS NOT
NULL" is a fact about *this* schema's encoding; a general system can only get it
from column descriptions/sample values, never from a rule the generator couldn't
produce. **Flag:** any fix that enumerates formula1 predicates ("finished",
"champion", "disqualified") in code is a patch. The honest general version depends
on the ontology generator emitting rich-enough column comments — i.e. it is
upstream of this pipeline and harder than it looks. Note it now.

---

## Recommended next brick

**IR-driven join minimization (minimal-subtree back-pruning of the FROM clause).**

After the planner returns the IR and before/within the compiler, restrict the
emitted FROM to the minimal connected subtree of the Steiner payload that spans
exactly the tables the IR references; drop all other payload tables and joins.

*Justification by measured cost × generality:*
- **Cost:** it directly addresses bucket 1 (~36 questions / the majority of all
  failures), including the 3 fan-out execute-errors, because those tables are
  *unreferenced* bridges the planner never used — they exist only because the
  compiler joins the whole payload.
- **Generality:** it is a pure graph/IRI operation with zero domain knowledge —
  it would behave identically on an unseen schema. It is the smallest change that
  severs the "anchoring/Steiner over-recall → guaranteed population corruption"
  chain, because it makes the FROM a function of what the answer *uses* rather than
  what retrieval *speculated*.
- **It also de-risks the harder bricks:** once the FROM reflects only used tables,
  bucket 2 (wrong-grain) and bucket 6 (994's leash exhaustion on a 7-table payload)
  become visible and measurable in isolation instead of being masked by noise.

*Explicitly out of scope for this brick* (do not let it scope-creep): bucket 2
(wrong fact table referenced by the plan) and bucket 3 (semantic predicates) —
both need a grain/schema-linking improvement, not join trimming, and at least
bucket 3 may be partly upstream of this pipeline entirely.
