# Step 2 — Uniqueness / Key Discovery

> Reference: Abedjan, Golab & Naumann, *Profiling relational data: a survey*,
> The VLDB Journal 24(4), 557–581 (2015), **§5.1 (unique column combinations & keys)**.
> DOI [10.1007/s00778-015-0389-y](https://doi.org/10.1007/s00778-015-0389-y) ·
> open access <https://dspace.mit.edu/handle/1721.1/106176>.

## Purpose

Find every **unique column-set** in the database — the columns (or small column
combinations) whose value-combinations never repeat. These are the only legal
**target sides (RHS)** of a relationship, because a foreign key can only point at a
unique column-set. Key discovery therefore produces the set of *candidate relationship
targets* that foreign-key discovery will test references against.

Source: [`src/profiling/key-discovery.ts`](../src/profiling/key-discovery.ts) ·
Type: [`src/types/key-candidate.ts`](../src/types/key-candidate.ts).

## Definitions (from §5.1)

- **Unique.** A column-set `X` is *unique* iff no two rows agree on `X`. Verified by the
  primitive:

  ```
  X is unique  ⟺  COUNT(DISTINCT X) = COUNT(*)
  ```

  (distinct value-combinations of `X` = number of rows ⇒ no duplicates).
- **Minimal unique.** A unique with no smaller unique subset — the *candidate key*.
  `{id, anything}` is unique but **not** minimal, so it is useless; we keep only minimal
  uniques.
- **Primary key.** A unique *explicitly chosen* as the record identifier. The survey says
  *uniques*, not *keys*, because a discovered unique is only valid for the data at one
  point in time.
- **Certain vs possible key (NULLs).** A unique with **no NULLs** is a *certain* key (a
  valid FK target); a unique but nullable column is only a *possible* key.

### Complexity — why this step is bounded

The survey proves that discovering **all** minimal uniques is **NP-hard**, and the result
set can be exponential (≥ 2^(n/2) minimal uniques for `n` columns). Dedicated algorithms
exist for the general case — **GORDIAN** (row-based), **HCA** and the column-lattice
Apriori traversal (column-based), **DUCC** (lattice random-walk), **SWAN** (incremental).
We deliberately implement only the tractable slice needed for relationship discovery
(see [Scope](#scope)).

## The three methods

Every result is tagged with the `method` that established it.

### 1. `single-column` — derive from profiles (free)

Filters the Step-1 [column profiles](single-column-profiling.md): a column with
`uniquenessRatio == 1.0` over a non-empty table is unique. No SQL is issued — the
uniqueness was already measured in Step 1.

```
keep column where numRows > 0 and uniquenessRatio == 1.0
   certain = (nullCount == 0)
   minimal = true            # a single column has no smaller subset
```

### 2. `composite-probe` — bounded Apriori search (k = 2)

Implements a single level (k = 2) of **bottom-up Apriori lattice traversal** (the
column-based approach, §5.1.2):

1. **Prune (Apriori rule):** *"every superset of a unique is also unique"* — so remove
   columns that are already single-column unique (combining them only yields non-minimal
   uniques). Also drop nullable and non-comparable columns (keeps `COUNT(DISTINCT row)`
   NULL-semantics clean; FK targets are certain keys anyway).
2. **Generate:** all 2-combinations of the remaining columns, **hard-capped** at
   `maxPairs` (default 200). If exceeded, it logs a warning and tests the first N —
   never a silent truncation.
3. **Verify (one batched query):**

   ```sql
   SELECT count(*) AS n,
          count(DISTINCT ("a","b")) AS k0,
          count(DISTINCT ("a","c")) AS k1, ...
   FROM "t"
   ```

   `k_i == n` ⇒ that pair is a **minimal** unique (minimal because single-uniques were
   pruned out). Tagged `certain = true`.

### 3. `declared` — catalog cross-check

One query against `information_schema.table_constraints` + `key_column_usage`, filtered to
`PRIMARY KEY` and `UNIQUE`, grouping columns per constraint (ordered by
`ordinal_position`). Not discovery — it reads the DBA's declared keys, used to:
- **trust** a data-discovered unique (a declared key is real, not a small-data coincidence);
- **fill gaps** — declared keys the data step did not probe (e.g. a 3-column PK) are still
  emitted as `method='declared'`.

### How they combine

```
              COUNT(DISTINCT X) == COUNT(*)          ← the one primitive
               /                        \
  single-column (k=1, free)       composite-probe (k=2, Apriori-pruned SQL)
               \                        /
                merge & cross-tag with
                declared (catalog PK/UNIQUE)
                          │
                    KeyCandidate[]
```

All data-driven methods reduce to the **same counting test**; they differ only in *which*
column-sets they apply it to and how the combinatorics are bounded.

## Output

A `KeyCandidate` per discovered key:

| Field | Meaning |
|-------|---------|
| `table`, `columns` | the unique column-set (1 or 2 columns) |
| `numRows`, `distinctCount` | counts behind the verdict (`distinctCount` null for declared-only) |
| `unique` | `distinctCount === numRows` (or trusted from a constraint) |
| `certain` | unique **and** no NULLs → valid FK target |
| `minimal` | no proper subset is unique |
| `declared` | `'primary'` / `'unique'` if it matches a constraint, else `null` |
| `method` | `single-column` · `composite-probe` · `declared` |

The **`declared` tag is the key signal**:

| `declared` | Interpretation |
|------------|----------------|
| `primary` / `unique` | data-unique **and** declared → confirmed real key |
| `null` | data-unique but undeclared → an *undeclared key discovery*, **or** a small-data coincidence |

## Worked example

### Input

```
customers                       orders                          order_products (junction)
 id │ email   │ city             id │ customer_id │ status        order_id │ product_id │ qty
 ───┼─────────┼──────            ───┼─────────────┼──────         ─────────┼────────────┼────
 1  │ a@x.com │ Tunis            10 │ 1           │ paid          10       │ 500        │ 2
 2  │ b@x.com │ Sfax             11 │ 1           │ open          10       │ 501        │ 1
 3  │ c@x.com │ Tunis            12 │ 2           │ paid          11       │ 500        │ 3
 PK: id ; UNIQUE: email          PK: id                          PK: (order_id, product_id)
```

### Trace

- **customers** — `id` distinct=3=rows → unique, PK ⇒ `declared:primary`. `email` distinct=3
  → unique, UNIQUE ⇒ `declared:unique`. `city` distinct=2 (Tunis repeats) → not unique.
- **orders** — `id` → unique ⇒ `declared:primary`. `customer_id` distinct=2 → **not unique**
  (correct: it is a FK *source*, not a target). `status` → not unique.
- **order_products** — `order_id` distinct=2, `product_id` distinct=2 → no single-column key.
  Composite probe: `COUNT(DISTINCT (order_id, product_id)) = 3 = COUNT(*)` → **unique** →
  minimal composite key, matches PK ⇒ `declared:primary`, `method:composite-probe`.

### Output

```
table            columns                unique  certain  minimal  declared  method
customers        id                     true    true     true     primary   single-column
customers        email                  true    true     true     unique    single-column
orders           id                     true    true     true     primary   single-column
order_products   order_id+product_id    true    true     true     primary   composite-probe
```

**4 key candidates = 4 legal relationship targets.** `orders.customer_id` is correctly
absent (not unique → can only be a *source*). The junction key was found **only** by
composite probing — enabling many-to-many detection later.

## How this helps downstream

- **Foreign-key discovery** restricts the target side to these keys → far smaller search
  space than testing every column pair.
- **Direction & cardinality:** target unique ⇒ the "one" side; a non-unique, type-matching
  column is the "many" side (drives 1:1 / 1:N / N:M).
- **Junction / many-to-many detection** comes from composite keys.
- **Undeclared-PK recovery:** `declared:null & unique:true` rows are keys the catalog never
  recorded — a direct contribution.
- **Confidence anchoring:** relationships pointing at a *declared* key score higher than
  those pointing at a coincidental small-data unique.

## Scope

| Included | Excluded (out of scope by design) |
|----------|-----------------------------------|
| single-column uniques | column-sets of size ≥ 3 |
| bounded 2-column composites (Apriori-pruned, capped) | full minimal-unique mining (GORDIAN/HCA/DUCC/SWAN) |
| declared PK / UNIQUE cross-tagging | functional dependencies; conditional / approximate uniques |

**Known limitation:** capping at k = 2 misses genuine composite keys of 3+ columns — a
deliberate tractability trade the survey justifies. Declared composite keys of any size are
still surfaced via the `declared` path.

## Caveat (small data)

Uniqueness describes the data at one moment; on a tiny table a column can be unique by
accident (over 1 row, *everything* is unique). The `declared` tag separates confirmed keys
from coincidences, and larger datasets make data-driven uniques far more reliable.

## Usage

```bash
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --keys
```

> `--keys` may be combined with `--single`. Connection is READ ONLY; only the `public`
> schema is read.

## Tests

[`test/nodes/key-discovery.test.ts`](../test/nodes/key-discovery.test.ts) — fake `Queryable`,
no database. Covers single-column certain/possible classification, declared-key grouping,
the composite-probe SQL, Apriori pruning, the non-null restriction, the `maxPairs` cap, and
the declared-vs-undeclared tagging (incl. an undeclared unique and a recovered composite PK).
