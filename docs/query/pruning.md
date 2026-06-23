# Stage 1.5 — semantic pruning (terminal set → grounded terminal set)

Pruning is the **missing middle stage** between grounding (S1 anchoring) and reasoning (S2 Steiner
routing): `anchor → PRUNE → subgraph`. Code: `src/query/prune.ts`, wired in
`src/query/pipeline.ts` (`subgraphNode`).

## Why it exists

S1 is deliberately **recall-favoring**: it over-returns candidate `terminals` so it never misses
(too few is unrecoverable; a few extra are filterable). But intact F1 is fully connected at low
Steiner cost — the *zero-cost spanning-subgraph* property — so S2 happily weaves **every**
recall-favoring terminal into one big tree. On the canonical "drivers eliminated in the first period
in race number 20", S1 returns 8 terminals and S2 routes a **9-table / 8-join** tree, when the
question only needs `qualifying` + `drivers` (+ `races`).

Pruning reconciles the two: keep S1 recall-favoring, then drop the terminals the question only
*brushed* before they distort the cheapest-tree routing. After pruning the same question routes a
**4-table / 3-join** tree.

## The correctness argument — must-include set, NOT may-traverse set

Pruning removes terminals from the **terminal set** (the classes Steiner must span), **never** from
the `OntologyGraph` Steiner traverses. Steiner stays free to route through unanchored **bridge**
classes (e.g. `drivers`/`results` bridging `laptimes`↔`constructors`). So pruning the must-include
set can never break connectivity — bridges are added at routing time. This mirrors PipeNet keeping
`V_q ∪ V_a` and pruning only the external/expansion set `V_e`. Recall safety:

- If two kept terminals can't connect without an unanchored bridge, Steiner adds the bridge.
- If pruning would leave **0** terminals, the empty-set fallback keeps the single best-grounded
  candidate (a trivial single-node subgraph). 1 terminal → trivial subgraph.

`deriveAnchoredColumns` is computed on the **full** AnchorSet (unchanged): pruned-away classes never
enter the tree, so their anchored columns are inert.

## The keep/prune rule (anchor provenance + keyword specificity)

Every S1 terminal is **already anchor-grounded by construction** — `anchorQuestion` builds
`terminals` exclusively from `conceptAnchors` (via `scopeClassIri`) ∪ `valueAnchors` (via `class`).
So "drop terminals with no anchor" prunes nothing. **Calibration against the real F1 index** showed
a naive *directness + score floor* rule is also insufficient: for the Q1 question every noise
terminal is grounded by a **direct, score-1.0** anchor (`constructorref`↔"reference",
`circuits.name`↔"name", `pitstops.driverid`↔"driver"), while the one terminal we must keep —
`qualifying` — has its only meaningful grounding at `q1`↔"first" **0.803**, *below* the noise. Score
is inverted; the discriminating signal is **specificity**.

A terminal `T` (class IRI) is **KEPT** iff (pure function over the `AnchorSet`):

1. **exact class anchor** — a `conceptAnchor` `kind:'class'`, `scopeClassIri === T`, `score ≥ 1.0`
   (the question named the table itself), OR
2. **value anchor** — a `valueAnchor` `class === T` (the question named a data value), OR
3. **specific keyword** — some grounding anchor on `T` (a non-`description` concept anchor scoped to
   `T`, or a value anchor classed to `T`) whose matched keyword has **document-frequency ≤
   `KEYWORD_DF`**, where `df(keyword)` = number of distinct scope classes that keyword grounds across
   the whole `AnchorSet`. df is an IDF-style term: a keyword that points at `T` *and few other
   classes* is discriminative; one that grounds many tables (a generic shared column like
   `name`/`id`/`number`) is not.

Otherwise DROPPED. No table name is hardcoded; the rule is fully **question-relative**.

### Why `KEYWORD_DF` defaults to 2, not 1

Profiled ontologies have **parallel entity pairs** (driver/constructor). A genuinely specific
concept like "championship points" legitimately maps to ~2 classes (`driverstandings` *and*
`constructorresults`). `df ≤ 1` would over-prune the needed table on "total championship points by
season" (leaving only `seasons`); `df ≤ 2` tolerates exactly one parallel sibling. Tunable via
`QUERY_PRUNE_KEYWORD_DF` (mirrors the `QUERY_EDGE_FLOOR_*` env convention) or the `opts.keywordDf`
argument; `CLASS_EXACT` (clause 1) stays at 1.0.

## The `constructors` flip (the rule doing real work, visibly)

Same class, opposite verdict, because the verdict is question-relative:

| Question | constructors grounding | Verdict |
|---|---|---|
| "…drivers eliminated in the first period in race number 20" | only `constructorref`↔"reference", `name`↔"name" (generic, df>2) | **DROPPED** |
| "average lap time for British constructors" | `class` anchor "constructor" (1.0) + `British` value anchor | **KEPT** (clause 1) |

If `constructors` survived Q1 → the over-join wouldn't shrink (floor too low); if it were dropped on
the happy path → the real query would break (floor too high). The flip working *is* the calibration.

## PruneTrace (the certificate / debugging spine)

```ts
PruneTrace {
  candidates: string[];                          // the recall-favoring input terminals
  kept: string[];                                // passed on to Stage 2
  dropped: { iri: string; reason: string }[];    // why each was removed
  groundedBy: Record<string, 'class'|'property'|'capability'|'value'>;  // per kept terminal
}
```

Surfaced on the pipeline state as `traces.prune`.

## Worked example (real index, `QUERY_PRUNE_KEYWORD_DF=2`)

```
Q: …drivers eliminated in the first period in race number 20
  candidates : circuits, constructors, drivers, pitstops, qualifying, races, results, constructorresults
  KEPT       : drivers[class], qualifying[property], races[class]
  DROPPED    : circuits, constructors, pitstops, results, constructorresults
  joins BEFORE: 8 (9 tables)   AFTER: 3 (4 tables)
```
