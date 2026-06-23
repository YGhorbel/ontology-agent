# IR Spec — the Stage-3 logical plan

The IR (`MetricQueryIR`, [src/query/ir.ts](../../src/query/ir.ts)) is the typed contract
between the planner (Stage 3a, an LLM, later) and the deterministic compiler (Stage 3b,
[src/query/compiler.ts](../../src/query/compiler.ts)). It expresses *what to compute* over a
`SubgraphPayload`; it never contains raw SQL or invented `table.column` strings. Everything it
names is an ontology IRI present in the payload.

> Design rule: **the LLM chooses, the graph constrains, the compiler writes.** The IR is the
> shape of the choice; `specializeIrSchema(payload)` is the constraint.

## Three shapes, one grammar

A single IR is **exactly one** of three shapes, distinguished by *which fields are present* — not
a literal tag (top-level zod `.refine`s enforce the discriminant). This generalization exists
because an audit of the gold set found 61% of questions ask for projection or ranking (no
aggregate); requiring a `measures` array forced the planner to invent aggregates (see ADR-007).

| Shape | Present fields | Emits |
|-------|----------------|-------|
| **projection** | `select` (+ `filters?`, `distinct?`) | `SELECT [DISTINCT] cols FROM … [WHERE …]` |
| **ranking** | projection **+ `orderBy`** (+ usually `limit`) | projection **+ `ORDER BY … [LIMIT n]`** — returns rows |
| **aggregation** | `measures` (≥1) (+ `groupBy?`) | the original metric query — `SELECT agg … [GROUP BY …]` |

Ranking is **not** a separate tag — it is mechanically "projection that has `orderBy`". The
discriminant is presence-of-field: `select` XOR `measures`; `groupBy` and `distinct` belong to
their respective shapes only.

```ts
MetricQueryIR {                                  // EXACTLY one of: { select } | { measures }
  // ── projection / ranking shape ──
  select?: { property: IRI }[];                  // ≥1; the columns to return (emitted as bare table.col)
  distinct?: boolean;                            // SELECT DISTINCT (projection/ranking only)
  // ── aggregation shape ──
  measures?: {                                   // ≥1; each is EXACTLY one of:
    capability?: IRI;                            //   a named metric → its formulaHint, expanded verbatim
    aggExpr?: { fn: 'COUNT'|'SUM'|'AVG'|'MIN'|'MAX'; property: IRI };  //   an ad-hoc aggregate
    alias?: string;
  }[];
  groupBy?: { property: IRI }[];                 // aggregation only ("per X" dimensions)
  // ── shared ──
  filters?: { property: IRI; op: '='|'!='|'<'|'<='|'>'|'>='|'IN'|'LIKE'; value: string|number|string[] }[];
  orderBy?: { byAlias?: string; byProperty?: IRI; dir: 'ASC'|'DESC'; nulls?: 'FIRST'|'LAST' }[];  // exactly one of byAlias|byProperty
  limit?: number;                                // positive integer
}
```

- **Property IRI** = `datatypePropertyIri(table, column)` → `qsl:property/<table>/<column>`.
- **Capability IRI** = the literal capability `@id` from the ontology, e.g.
  `qsl:capability/metric/laptimes/average-lap-time-ms` (a slug, *not* column-derived).
- Refines: exactly one of `{select, measures}`; `groupBy` only with `measures`; `distinct` only
  with `select`. A measure carries exactly one of `{capability, aggExpr}`; an `orderBy` exactly
  one of `{byAlias, byProperty}`.
- **`orderBy.nulls`** is optional; when omitted the compiler emits no `NULLS` clause and Postgres'
  native default applies (`ASC` → NULLS LAST, `DESC` → NULLS FIRST).

## Examples

Projection (read columns + filter), deduplicated:
```jsonc
{ "select": [{ "property": "qsl:property/circuits/lat" }, { "property": "qsl:property/circuits/lng" }],
  "distinct": true,
  "filters": [{ "property": "qsl:property/circuits/name", "op": "=", "value": "Silverstone Circuit" }] }
```

Ranking ("the oldest driver" → order by a column, take 1):
```jsonc
{ "select": [{ "property": "qsl:property/drivers/forename" }, { "property": "qsl:property/drivers/surname" }],
  "orderBy": [{ "byProperty": "qsl:property/drivers/dob", "dir": "ASC" }],
  "limit": 1 }
```

Aggregation — capability metric, grouped + filtered:
```jsonc
{ "measures": [{ "capability": "qsl:capability/metric/laptimes/average-lap-time-ms", "alias": "avg_ms" }],
  "groupBy":  [{ "property": "qsl:property/constructors/nationality" }],
  "filters":  [{ "property": "qsl:property/constructors/nationality", "op": "=", "value": "British" }] }
```

Aggregation — ad-hoc aggregate over a cumulative-snapshot column (the compiler de-cumulates it — see compiler.md):
```jsonc
{ "measures": [{ "aggExpr": { "fn": "SUM", "property": "qsl:property/driverstandings/points" }, "alias": "total_points" }],
  "groupBy":  [{ "property": "qsl:property/races/year" }] }
```

## `specializeIrSchema(payload)` — the planner leash

Narrows the schema so the only legal property IRIs are those of the payload's classes' columns,
and the only legal capability IRIs are the payload's capabilities. It walks **`select`**,
`measures`, `groupBy`, `filters`, and `orderBy.byProperty`. An out-of-payload reference fails
`parse`/`safeParse` with a precise issue path (`select[0].property`, `measures[0].aggExpr.property`, …).
Built and tested now; it is what will bind GPT-5-mini's structured output in Stage 3a. **No LLM is
called in Stage 3b.**

## Deliberately NOT expressible (routes to a future fallback)

- LLM-authored subqueries / CTEs / arbitrary SQL — the LLM picks IRIs, never writes SQL.
- `HAVING`, window/analytic measures, multi-fact `UNION`, set operations.
- Ratios / percentages and multi-CTE time math (the ~17% complex gold bucket).
- **Time-string ordering** — sorting a text column holding times like `"1:23.796"`: `orderBy`
  casts plain `isNumericText` columns to `numeric`, but a time-formatted string is not a clean
  numeric cast and is a documented limitation.
- Joins. The join skeleton is Stage 2's (`payload.joins`); the IR cannot add, remove, or reorder it.

When a question needs something here, the planner routes to a fallback rather than emitting an IR
the compiler would have to bend — preserving the clean "wrong IR vs wrong compiler" separability.
