# Grain resolver (Stage 3a.5) — operation⇒grain, resolve where deterministic, surface where irreducible

`src/query/grain-resolve.ts` is the tier-1 grain resolver (ADR-016). It sits between the planner (S3a)
and the compiler (S3b) as a pure node: it **resolves** a grain-competitor column to the
operation-implied sibling where the operation shape determines grain, and **surfaces** (flags, never
guesses) the irreducible case where only question intent could.

It completes the three-brick grain chain:

> **survive both** (ADR-014 sibling-survival) → **tag both** (ADR-013 menu + ADR-015 snapshot probe) →
> **resolve to one** (this brick) → **back-prune drops the other** (ADR-012).

## Lexicon-free by construction

`resolveGrain(ir, payload, graph)` does **not** receive the question string. The operation shape is read
only from IR structure and payload/graph structure, so a lexical cue *cannot* leak in — H4 compliance is
a structural guarantee, not a promise. (The `graph` argument supplies only FK-symmetry — structure, not
text.)

## The grain-competitor trigger — FK-symmetric siblings only

A column is a grain competitor for the planner's binding iff its **FK-symmetric sibling component**
(ADR-014's exact `fkSymmetric` test — identical declared-neighbour signature after removing each other)
contains ≥2 members carrying that column name with **differing grain**. Grain maps from
`qsl:temporality`: `cumulative-snapshot`→cumulative, `as-of-event-snapshot`→snapshot, *absent*→per-event.

FK-symmetry is load-bearing: it confines a rebind to a true grain sibling
(`constructorresults`↔`constructorstandings`, both → `constructors`) and **never swaps the entity**. A
`points` column also lives on `driverstandings`, but that table is FK-symmetric to neither constructor
table (it joins `drivers`), so it is never a rebind target — a driver-points SUM is left exactly as the
planner bound it.

## Operation shape (from IR + payload structure)

Classified per grain-competitor column, **pin-first** (any pin → ASOF, so we never wrongly rewrite a
pinned case):

| Shape | Structural signal | Implied grain | Action |
|---|---|---|---|
| `ASOF_EVENT_FILTER` | a **single-event pin** is present | — (intent-dependent) | **surface** (flag, no rewrite) |
| `MAX_OR_LATEST_UNPINNED` | `MAX`/`MIN` on the grain col, or `ORDER BY` the grain col (+`LIMIT`), no pin | standings | bind the tagged sibling |
| `AGG_OVER_EVENTS` | `SUM`/`AVG`/`COUNT` on the grain col, no pin | per-event | bind the untagged sibling |
| `PER_ROW_SELECT` | bare projection, no aggregate, no pin | unconstrained | no-op |

A **single-event pin** is either (a) an equality (`=`) to a constant on a **join-key column name** (e.g.
`raceId = 291` — `points = 0` is *not* a pin: `points` is the grain column, not a join key), or
(b) `orderBy` + `LIMIT 1` selecting one row by an ordering that is **not** the grain column (the grain
column read as-of that row, e.g. `ORDER BY year ASC LIMIT 1`).

Implied grain is **binary** (per-event vs standings): each sibling component has one untagged member and
one tagged standings member, so the operation only needs to pick untagged-vs-tagged — it never has to
choose cumulative-vs-as-of.

## Resolve vs surface

- **Resolve:** if the planner bound the wrong grain, rewrite every IR slot referencing that column to the
  **unique** sibling of the implied grain. Deterministic re-selection of *which* column binds — the
  operation the planner chose is untouched. Recorded in `grainResolve.resolutions`.
- **Surface:** on `ASOF_EVENT_FILTER` (or any non-unique target — the defensive guard), record
  `grainResolve.ambiguities` with the competing candidates + a structural note, and **keep the planner's
  binding** as the honest non-interactive fallback. `grainAmbiguous` ⇔ `ambiguities` non-empty. No
  lexical tie-break is ever used to "win" 869/950 — the diagnostic proved it needs intent.

## Composition

- **Back-prune (ADR-012):** after a rebind, the unreferenced sibling is an FK-symmetric degree-1 leaf →
  back-prune drops it from the FROM. No over-join. (A reference split would require the IR to also bind a
  non-grain column of the source sibling, which only co-occurs with a join-key pin = the ASOF case, which
  is never rewritten.)
- **Move-1 menu (ADR-013) is complementary, not redundant:** the menu *surfaces* grain to the LLM; this
  resolver is the deterministic *bind-from-evidence* safety net for separable shapes (950 proved
  surfacing alone is insufficient).

See [ADR-016](../adr/016-operation-grain-resolver.md), the
[grain-separability diagnostic](../diagnosis/grain-separability.md), and ADR-012/013/014/015.
