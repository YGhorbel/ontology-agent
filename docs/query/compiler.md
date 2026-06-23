# Stage 3b — the deterministic compiler

`compile(ir, payload) → { sql, trace }` ([src/query/compiler.ts](../../src/query/compiler.ts))
turns a `MetricQueryIR` + a real Stage-2 `SubgraphPayload` into a Postgres SQL string. No LLM, no
DB. The gate is a parse-check with `pgsql-ast-parser` — the same parser the formula validator uses
([src/validation/formula-validator.ts](../../src/validation/formula-validator.ts)).

> **The compiler renders the payload's joins verbatim and never selects a join.** It chooses nothing
> about routing; it only writes what the IR asks over the skeleton Stage 2 already decided.

## Relation aliasing

Alias = **table name**. The Steiner tree visits each table once, so this is unambiguous, lets
capability `formulaHint`s (`AVG(laptimes.milliseconds)`) expand verbatim, and keeps every column
reference stable. The only generated identifier is `__qsl_snap_rn` (de-cumulation row number).

## Ordered passes

Each pass consumes only payload facts (the payload was additively enriched at the Stage-2 seam to
carry `formulaHint`/`unit` on capabilities and `isNumericText`/`temporalityEvidence` on columns —
see ADR-003). Every pass appends to `trace` for the eventual certificate.

1. **Validation / scope coherence.** Every IR property/capability IRI must resolve in the payload.
   For a capability measure, its `formulaHint` is parsed with `referencedColumns()` and **every
   referenced table must be a class in the payload** — else `CompileError('scope-table', <table>)`.
   This guards the generator-era scope bug (a metric whose formula reaches a table outside the tree).
   Nothing is silently dropped.
2. **Measure expansion.** `capability` → its `formulaHint` verbatim. `aggExpr` → `fn(<table>.<col>)`
   resolved from the property IRI.
3. **Join materialization.** `FROM <root>` then one `JOIN <table> ON <pairs>` per `payload.joins`
   edge, using the literal `on` column pairs; a composite edge (≥2 pairs) emits a multi-column `AND`
   condition. Exactly the payload's joins — no more, no fewer (fold-consumed edges excepted, pass 4).
4. **Temporality rewrite (H2).** A plain `SUM`/`AVG` over a **cumulative-snapshot** column
   double-counts a running total. When an `aggExpr` measure's column carries
   `temporality = 'cumulative-snapshot'`, the compiler de-cumulates: it snapshots the final row per
   `(entity, season)` partition. See the dedicated section below. Scope: **aggExpr measures only** —
   capability `formulaHint`s expand verbatim (a naive-aggregate-over-cumulative formula is a
   documented known-gap, not rewritten here).
5. **Filter.** `WHERE` from IR filters: strings quoted/escaped, `IN` → list, `LIKE` passthrough.
6. **Numeric-text cast.** A column with `isNumericText = true` used numerically gets
   `CAST(<col> AS numeric)` — for a numeric aggregate `fn` (`SUM`/`AVG`/`MIN`/`MAX`) or a numeric
   comparison (`<`,`<=`,`>`,`>=`, or `=`/`!=` against a number). `LIKE`/string `IN` are not cast.
   `formulaHint`s are not re-cast (they already carry their own validated CAST).
7. **Assemble + parse-check.** Compose `SELECT/FROM/JOIN/WHERE/GROUP BY/ORDER BY/LIMIT`, then
   `parse()` the result. A parse failure becomes `CompileError('parse', <sql>)`.

## The temporality rewrite (exact SQL form)

Cumulative-snapshot columns (`driverstandings.points`, `constructorstandings.points`) are running
totals carried race-to-race. The de-cumulation uses the column's `temporalityEvidence`
(`partitionColumns`, `orderColumn`) and emits a `ROW_NUMBER` derived table, keeping rn = 1
(the max-order row) per partition:

```sql
FROM ( SELECT <T>.*, <foreign grain cols re-exposed>,
              ROW_NUMBER() OVER (PARTITION BY <partition exprs> ORDER BY <order expr> DESC) AS __qsl_snap_rn
       FROM <T> [JOIN <calendar> ON <payload edge pairs>] ) AS <T>
WHERE <T>.__qsl_snap_rn = 1
```

### Cross-table grain (the verified F1 reality)

`driverstandings.points` has `partitionColumns: [driverid, year]`, `orderColumn: round` — but
`year`/`round` live in **`races`**, not `driverstandings` (the monotonicity profiler reached them by
joining `driverstandings t JOIN races r ON t.raceid = r.raceid`,
[src/profiling/monotonicity.ts](../../src/profiling/monotonicity.ts)). So the compiler:

- Splits grain columns into LOCAL (on T) and FOREIGN.
- Requires all FOREIGN columns to live on **one** payload class joined to T by **one** `payload.joins`
  edge (here `races`, edge on `raceid=raceid`). That edge is **folded into the derived table and
  consumed** from the outer join set — it is still the payload's edge, rendered verbatim, never
  re-derived. If the calendar columns are unreachable in the payload →
  `CompileError('temporality-unreachable')`; a FOREIGN name colliding with a T column →
  `CompileError('temporality-collision')`.
- The partition stays per-`(driver, season)`, so a multi-season career is never collapsed.

Compiled output (aggExpr `SUM(driverstandings.points)` grouped by `races.year`):

```sql
SELECT driverstandings.year AS year, SUM(driverstandings.points) AS total_points
FROM (SELECT driverstandings.*, races.year AS year, races.round AS round,
             ROW_NUMBER() OVER (PARTITION BY driverstandings.driverid, races.year
                                ORDER BY races.round DESC) AS __qsl_snap_rn
      FROM driverstandings JOIN races ON driverstandings.raceid = races.raceid) AS driverstandings
WHERE driverstandings.__qsl_snap_rn = 1
GROUP BY driverstandings.year
```

By contrast `results.points` carries no temporality → `SUM(results.points)`, no window, no fold.

> Note (data-grounded): `driverstandings→races` is a *discovered* FK (conf 0.95), not declared, so
> confidence-mode routing takes the zero-cost declared detour and never makes `races` adjacent.
> Uniform mode picks the 1-hop discovered edge, which is how the fold is exercised. Same mechanism,
> different H1 routing knob.

## Errors

`CompileError { message, code, offending? }`. Codes: `scope-table`, `scope-column`,
`scope-capability`, `capability-no-formula`, `temporality-no-evidence`, `temporality-unreachable`,
`temporality-collision`, `temporality-folded-column`, `join-disconnected`, `empty-scope`, `parse`.
