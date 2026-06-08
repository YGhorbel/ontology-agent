# Step 3 — Candidate Generation + Prefilter

> Reference: Abedjan, Golab & Naumann, *Profiling relational data: a survey*,
> The VLDB Journal 24(4), 557–581 (2015), **§5.3 (inclusion dependencies)**.
> DOI [10.1007/s00778-015-0389-y](https://doi.org/10.1007/s00778-015-0389-y).

## Purpose

Form candidate column pairs `(A → B)` — where A is a potential foreign-key **source**
and B a potential **target** — and **cheaply discard the impossible ones** using only
Step-1 statistics, *before* the expensive value-containment scan. This is the step that
stops the O(columns²) blowup of testing every column against every other column.

Source: [`src/profiling/candidate-pairs.ts`](../src/profiling/candidate-pairs.ts) ·
Type: [`src/types/candidate-pair.ts`](../src/types/candidate-pair.ts).

## Background (from §5.3)

- An **inclusion dependency (IND)** `A ⊆ B` holds when **every value of A also appears in
  B**. A is the LHS (FK source), B the RHS (target).
- **§5.3.5 — INDs are the precursor to foreign keys:** *"a foreign key must satisfy the
  corresponding inclusion dependency, but not all INDs are foreign keys"*, and *"a primary
  key should appear in the RHS of multiple INDs"* → **the target B is a key**. So B ranges
  over the Step-2 key candidates.
- Verifying `A ⊆ B` requires a **full data scan** (the SPIDER / De Marchi algorithms sort or
  index every column's values). Running that on every column pair is prohibitively
  expensive — hence the prefilter.

## The prefilters (necessary conditions for A ⊆ B)

All three reuse Step-1 stats only — **no new queries**. Each is a *necessary* condition: if
it fails, `A ⊆ B` is provably impossible, so the pair is dropped.

| Prefilter | Rule | Why it's necessary |
|-----------|------|--------------------|
| **type-incompatible** | `family(A) == family(B)`, not `other` | values of different families can't contain one another |
| **distinct-exceeds** | `distinct(A) ≤ distinct(B)` | if A has more distinct values than B, they can't all be in B |
| **range-outside** | `[min(A),max(A)] ⊆ [min(B),max(B)]` | a value of A beyond B's range can't be in B |

Plus two structural guards: **same-column** (a column can't reference itself) and
**source-empty-or-allnull** (no values worth relating).

> **Provably-impossible only.** A pair is dropped *only* when a stat proves impossibility.
> If a needed stat is missing (e.g. a non-profilable type with `null` distinct), the
> prefilter does **not** prune — it errs toward keeping. The prefilter is *necessary*, not
> *sufficient*: surviving pairs still must be confirmed by the Step-4 containment scan.

### Type families & the `::text` range compare

Types are grouped into families — `numeric`, `text`, `temporal`, `uuid`, `boolean`,
`other` — so compatible-but-not-identical types still match (e.g. `bigint` ↔ `integer`).
Because Step-1 stores `min`/`max` as `::text`, the range check re-casts per family:
**numeric** values are parsed with `Number()`, everything else compares lexicographically
(correct for ISO timestamps, uuid, boolean). This matters — lexicographically `"100" < "99"`,
but numerically `100 > 99`, so a numeric range check must parse.

## Scope (confirmed)

- **Target B** = single-column **key candidates** only (unique) — a FK target is a key.
- **Unary** pairs only (single col → single col).
- **Self-references included** — same-table pairs are kept (`manager_id → id`).
- **Deferred:** composite / n-ary candidate pairs; targets that aren't keys; the actual
  containment scan (Step 4); FK ranking/scoring (later).

## Output

A `CandidatePair` per survivor:

| Field | Meaning |
|-------|---------|
| `sourceTable`, `sourceColumn` | the LHS (potential FK source) |
| `targetTable`, `targetColumn` | the RHS (a single-column key) |
| `typeFamily` | the shared family that passed the compat check |
| `sourceDistinct`, `targetDistinct` | carried for downstream ranking |
| `selfReference` | `sourceTable === targetTable` |

## Worked example

Targets (keys from Step 2): `customers.id`, `orders.id`, `employees.id`.

| source | candidate target | verdict |
|--------|------------------|---------|
| `orders.customer_id` (int, distinct 200, [1,200]) | `customers.id` (int, distinct 1000, [1,1000]) | **kept** — type ✓, 200≤1000 ✓, range ✓ |
| `employees.manager_id` (int, [1,50]) | `employees.id` (int, [1,50]) | **kept**, `selfReference: true` |
| `customers.name` (varchar) | `customers.id` (int) | **dropped** — type-incompatible |
| `orders.id` (distinct 500) | `employees.id` (distinct 50) | **dropped** — distinct-exceeds (500 > 50) |
| `x` ([1,300]) | `id` ([1,200]) | **dropped** — range-outside |

## How this helps downstream

The survivors are the **only** pairs Step 4 (inclusion-dependency verification) needs to
run its expensive value-containment scan on. By cutting the full source×target grid down to
the plausible few, Step 3 makes FK discovery tractable. The kept pairs already carry the
direction (source → key target) and the self-reference flag.

## Usage

```bash
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --pairs
```

Prints the candidate pairs and a reduction summary, e.g.
`Kept 33 of 315 possible pairs (21 source columns × 15 key targets) after prefilter.`
`--pairs` runs key discovery internally (it needs the targets) and may be combined with
`--single` / `--keys`.

## Caveat (small data)

On tiny tables almost every column is unique, so Step 2 yields many "key targets" and many
pairs survive — including coincidences. The prefilter is necessary, not sufficient; larger
data yields fewer keys and the Step-4 containment test removes the false survivors.

## Tests

[`test/nodes/candidate-pairs.test.ts`](../test/nodes/candidate-pairs.test.ts) — fake-free,
pure-function tests covering `typeFamily`, every `prefilterPair` drop reason (incl. the
numeric-vs-lexicographic range check), and `generateCandidatePairs` (key-only targets,
self-references, and the reduction vs the full grid).
