# Data Profiling — Documentation

This folder documents the **data-profiling** capabilities of the ontology agent: the
deterministic steps that examine a PostgreSQL datasource and extract metadata used to
recover **relationships that were never declared** as foreign-key constraints.

> **Start here:** [ontology-build.md](ontology-build.md) — the end-to-end story of how the
> ontology is built from scratch, how profiling and column **naming** combine as peer evidence
> sources, and **how strong** the result is (what it catches, what it misses, and why). The
> per-step docs below drill into the individual profiling stages.
>
> **Query side:** [joinpath.md](joinpath.md) — how the join resolver (`pnpm run joinpath`) is
> built: the graph model, the algorithms (Dijkstra / Steiner / Yen's K-best), and the
> evolution with the pros, cons, and bugs faced at each step plus the limitations ahead.

## Why profiling

The agent's original limitation: it discovered relationships **only from declared
foreign keys** (`information_schema`). Real databases are full of *implicit* structure —
undeclared foreign keys, junction tables, composite keys — that a human infers when
writing JOINs but the catalog never records. In the survey's terms this task is
**database reverse engineering**: recovering "implicit constructs" (foreign keys,
cardinalities) from a bare database instance.

The catalog tells you what the database *was told about itself*; **profiling tells you
what the data *actually is*** — and the missing relationships live in the gap between the
two.

## The profiling steps

| Step | Document | What it produces |
|------|----------|------------------|
| 1 | [single-column-profiling.md](single-column-profiling.md) | Per-column statistics (type, rows, nulls, distinct, uniqueness ratio, min/max) |
| 2 | [key-discovery.md](key-discovery.md) | Unique column-sets = the legal **target sides** of relationships |
| 3 | [candidate-pairs.md](candidate-pairs.md) | Candidate `(source → key)` pairs surviving a statistical prefilter |

Step 1 is the cheap input layer; Step 2 builds on it to identify keys; Step 3 pairs every
column against those keys and cheaply prunes the impossible pairs. Together they produce the
candidate **(source → target) pairs** that the next step (inclusion-dependency /
foreign-key discovery) verifies with a value-containment scan.

## Running

```bash
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --single   # Step 1
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --keys      # Step 2
pnpm run profile --dsn "postgresql://user:pass@host:5432/db" --single --keys
```

> Use `pnpm run profile` (not `pnpm profile` — `profile` is a reserved npm/pnpm built-in).
> The connection is **READ ONLY**; only the `public` schema is read.

## Scope philosophy

Each step is grounded in the survey but **deliberately bounded**: we implement the
tractable slices that serve relationship discovery and explicitly refuse the NP-hard
general cases (full minimal-unique mining, functional dependencies, conditional/approximate
dependencies). Each document states its scope and what it leaves out.

## Reference

All steps are based on:

> **Z. Abedjan, L. Golab, F. Naumann.** *Profiling relational data: a survey.*
> The VLDB Journal **24**(4), 557–581 (2015). DOI:
> [10.1007/s00778-015-0389-y](https://doi.org/10.1007/s00778-015-0389-y).
> Open access: <https://dspace.mit.edu/handle/1721.1/106176>

Section pointers used by these docs:
- **§3.1 / §3.3** — single-column profiling (cardinalities, data types). → Step 1
- **§5.1** — unique column combinations & keys. → Step 2
- **§5.3** — inclusion dependencies (precursor to foreign keys). → Step 3
- **§1.1** — use cases: *database reverse engineering*, *data integration*.
