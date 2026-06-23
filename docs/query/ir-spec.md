# IR Spec — the Stage-3 logical plan

The IR (`MetricQueryIR`, [src/query/ir.ts](../../src/query/ir.ts)) is the typed contract
between the planner (Stage 3a, an LLM, later) and the deterministic compiler (Stage 3b,
[src/query/compiler.ts](../../src/query/compiler.ts)). It expresses *what to compute* over a
`SubgraphPayload`; it never contains raw SQL or invented `table.column` strings. Everything it
names is an ontology IRI present in the payload.

> Design rule: **the LLM chooses, the graph constrains, the compiler writes.** The IR is the
> shape of the choice; `specializeIrSchema(payload)` is the constraint.

## Grammar

```ts
MetricQueryIR {
  measures: {                                    // ≥1; each is EXACTLY one of:
    capability?: IRI;                            //   a named metric → its formulaHint, expanded verbatim
    aggExpr?: { fn: 'COUNT'|'SUM'|'AVG'|'MIN'|'MAX'; property: IRI };  //   an ad-hoc aggregate
    alias?: string;
  }[];
  groupBy?: { property: IRI }[];
  filters?: { property: IRI; op: '='|'!='|'<'|'<='|'>'|'>='|'IN'|'LIKE'; value: string|number|string[] }[];
  orderBy?: { byAlias?: string; byProperty?: IRI; dir: 'ASC'|'DESC' }[];   // exactly one of byAlias|byProperty
  limit?: number;                                // positive integer
}
```

- **Property IRI** = `datatypePropertyIri(table, column)` → `qsl:property/<table>/<column>`.
- **Capability IRI** = the literal capability `@id` from the ontology, e.g.
  `qsl:capability/metric/laptimes/average-lap-time-ms` (a slug, *not* column-derived).
- A measure must carry exactly one of `{capability, aggExpr}` (zod `.refine`); an `orderBy` exactly
  one of `{byAlias, byProperty}`.

## Examples

Capability metric, grouped + filtered:
```jsonc
{ "measures": [{ "capability": "qsl:capability/metric/laptimes/average-lap-time-ms", "alias": "avg_ms" }],
  "groupBy":  [{ "property": "qsl:property/constructors/nationality" }],
  "filters":  [{ "property": "qsl:property/constructors/nationality", "op": "=", "value": "British" }] }
```

Ad-hoc aggregate over a cumulative-snapshot column (the compiler de-cumulates it — see compiler.md):
```jsonc
{ "measures": [{ "aggExpr": { "fn": "SUM", "property": "qsl:property/driverstandings/points" }, "alias": "total_points" }],
  "groupBy":  [{ "property": "qsl:property/races/year" }] }
```

## `specializeIrSchema(payload)` — the planner leash

Narrows the schema so the only legal property IRIs are those of the payload's classes' columns,
and the only legal capability IRIs are the payload's capabilities. An out-of-payload reference
fails `parse`/`safeParse` with a precise issue path (`measures[0].aggExpr.property`, …). Built and
tested now; it is what will bind GPT-5-mini's structured output in Stage 3a. **No LLM is called in
Stage 3b.**

## Deliberately NOT expressible (routes to a future fallback)

- LLM-authored subqueries / CTEs / arbitrary SQL — the LLM picks IRIs, never writes SQL.
- `HAVING`, window/analytic measures, multi-fact `UNION`, set operations.
- Joins. The join skeleton is Stage 2's (`payload.joins`); the IR cannot add, remove, or reorder it.

When a question needs something here, the planner routes to a fallback rather than emitting an IR
the compiler would have to bend — preserving the clean "wrong IR vs wrong compiler" separability.
