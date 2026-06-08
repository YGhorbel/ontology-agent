# Step 1 — Single-Column Profiling

> Reference: Abedjan, Golab & Naumann, *Profiling relational data: a survey*,
> The VLDB Journal 24(4), 557–581 (2015), **§3.1 (cardinalities)** and **§3.3 (data
> types)**. DOI [10.1007/s00778-015-0389-y](https://doi.org/10.1007/s00778-015-0389-y).

## Purpose

Compute, for **every column** of every table, the cheap statistics that describe the
column's data. These per-column metrics are the **input layer** for the later steps:
key discovery (Step 2) and foreign-key / inclusion-dependency discovery.

Source: [`src/profiling/single-column.ts`](../src/profiling/single-column.ts) ·
Type: [`src/types/column-profile.ts`](../src/types/column-profile.ts).

## The six metrics

| Metric | Source | Why it matters (per survey) |
|--------|--------|------------------------------|
| `dataType` | catalog (`Column.type`) | §3.3 — first prefilter; never compare an integer column to a timestamp |
| `numRows` | `COUNT(*)` | §3.1 — denominator for the null and uniqueness ratios |
| `nullCount` | `numRows − COUNT(col)` | §3.1 — nullable columns can still be FK sources; all-null columns are junk |
| `distinctCount` | `COUNT(DISTINCT col)` | §3.1 — the *costly* one (needs hashing/sorting); negative-containment prefilter |
| `uniquenessRatio` | `distinctCount / numRows` | §3.1 — ≈1.0 ⇒ key candidate ⇒ valid relationship **target** |
| `min` / `max` | `MIN(col)` / `MAX(col)` | §3.1 — instant negative range test |

The survey's efficiency point (§3.1): **everything except `distinctCount` is a single
pass** over the column. So all metrics for a table are **batched into one `SELECT`** —
one database round-trip per table, not one per column.

## How it works

For each table, one batched query:

```sql
SELECT count(*) AS n,
       count("id")  AS c0__nn, count(DISTINCT "id")  AS c0__d, min("id")::text  AS c0__min, max("id")::text  AS c0__max,
       count("city") AS c1__nn, count(DISTINCT "city") AS c1__d, min("city")::text AS c1__min, max("city")::text AS c1__max,
       ...
FROM "customers"
```

Then derive per column:

```
nullCount       = numRows − nonNullCount
nullRatio       = nullCount / numRows           (0 for an empty table)
uniquenessRatio = distinctCount / numRows       (null when numRows = 0)
```

Design choices:
- **Index-based aliases** (`c0__nn`, `c1__d`, …) avoid PostgreSQL's 63-character
  identifier limit and any name collisions.
- **`PROFILABLE_TYPES` allowlist** — `DISTINCT`/`MIN`/`MAX` are emitted only for types that
  support equality/ordering. Columns of `json` / `xml` / `ARRAY` still get
  `numRows` / `nullCount`, but their `distinctCount` / `min` / `max` stay `null` instead of
  raising a runtime error.
- **`min`/`max` are stored as `::text`** so the shape is uniform across all column types;
  a numeric range comparison must re-cast to the column's `dataType`.

## Output

A `ColumnProfile` per column:

```jsonc
{
  "table": "orders", "column": "customer_id", "dataType": "integer",
  "numRows": 1000, "nullCount": 0, "nullRatio": 0,
  "distinctCount": 200, "uniquenessRatio": 0.2,
  "min": "1", "max": "200"
}
```

## Worked example

For a `customers` table (3 rows):

| column | type | rows | nulls | distinct | unique% | min | max | reading |
|--------|------|-----:|------:|---------:|--------:|-----|-----|---------|
| id | integer | 3 | 0 | 3 | 100% | 1 | 3 | unique → key candidate / FK target |
| email | varchar | 3 | 0 | 3 | 100% | a@… | c@… | unique → key candidate |
| city | varchar | 3 | 0 | 2 | 67% | Sfax | Tunis | repeats → not a key |

The headline signal is **`uniquenessRatio`**: `id` and `email` at 100% are key candidates
(possible relationship targets); `city` at 67% is not.

## What it does *not* do

It describes columns **in isolation**. It does **not** assert a relationship — that needs
comparing one column against another (containment), which is a later step. It only hands
the next steps the per-column evidence and the prefilters (type, range, cardinality) that
let them avoid expensive work.

## Caveat

Distinct counts and ratios describe the data **at one point in time**, and on very small
tables a column can look unique by accident. This is why Step 2 cross-checks against
declared constraints and larger datasets give more reliable signals.

## Usage

```bash
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --single
```

Output is a `console.table` per table; nothing is written to disk.

## Tests

[`test/nodes/single-column-profile.test.ts`](../test/nodes/single-column-profile.test.ts) —
fake `Queryable`, no database required. Covers the metrics, ratio derivations, empty table,
all-null column, and the non-profilable-type guard.
