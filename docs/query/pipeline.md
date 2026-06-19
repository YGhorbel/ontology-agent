# Query pipeline (Stage 4) — the five-stage flow

`src/query/pipeline.ts` wires the five query stages into one LangGraph flow:

```
question ──▶ anchor ──▶ subgraph ──▶ planner ──▶ compile ──▶ execute ──▶ {sql, rows}
                 │            │            │           │           │
   (S1)        AnchorSet   Payload        IR          SQL        rows
                            │            │           │           │
                       disconnected? repair-     CompileError  query
                            │       exhausted?     │           error?
                            ▼            ▼           ▼           ▼
                         PipelineFailure (graceful terminal state, carries partial traces)
```

This is **integration only** — each node calls a stage's existing public entry point; no stage
internals change here. The exit gate is "a raw question flows through all five stages to SQL+rows,
and the two failure paths terminate gracefully" — NOT answer correctness (accuracy is deferred).

## Entry point

```ts
runPipeline(question, {
  index, graph, capabilities,   // built ONCE from the fixture, passed in (not rebuilt per call)
  llm?,                         // planner LLM — omit for the real model; inject a fake in tests
  db?,                          // read-only executor — omit to stop after compile (SQL-only)
  anchorOpts?, plannerOpts?, extractOpts?,
}) → PipelineResult
```

`PipelineResult` is `{ ok: true, sql, rows?, columns?, anchorSet, payload, ir, traces }` or
`{ ok: false, failure, traces, anchorSet?, payload?, ir? }`.

The smoke driver is `pnpm ask "<question>"` (`scripts/ask.ts`), which builds the deps from the
committed formula1 fixture, uses the real LLM, executes only if `EVAL_FORMULA1_DSN` is set, and
prints terminals → payload joins → IR → SQL → rows (or the failure + stage). A `--max-terminals N`
flag tightens S1's recall-favoring candidate set when the default broad set over-joins.

## State shape

Mirrors `src/agent/state.ts` (LangGraph `Annotation.Root`, last-write-wins channels):
`question, anchorSet, payload, ir, sql, rows, columns, failure`, plus `traces` (a merge-reducer
channel each node appends its slice to). The injected collaborators (`index/graph/capabilities/
llm/db`) are **closed over by the node factories**, not stored in state.

## `anchoredColumns` derivation — H2-load-bearing (CRITICAL #1)

`deriveAnchoredColumns(anchorSet)` (exported, pure) turns the AnchorSet into the
`Map<classIri, columnName[]>` that S2's `trimColumns` needs:

- each **valueAnchor** → its column (parsed from `.property` = `qsl:property/<table>/<column>`)
  under its `.class`;
- each **conceptAnchor** of `kind:'property'` → its column under the class derived from the
  property IRI's table;
- `class` / `capability` concept anchors contribute **no** column directly.

**Why it is load-bearing.** S2's trimmer keeps only join-key / anchored / terminal-sample columns.
A measure column like `driverstandings.points` — and its `temporalityEvidence` — is dropped unless
it is anchored. Without that evidence the compiler can't tell the column is a cumulative snapshot
and would silently emit a naive `SUM`. The derivation makes the evidence survive the trim, so the
compiler instead applies the H2 snapshot rewrite (`ROW_NUMBER() … __qsl_snap_rn = 1`) — or, when it
can't, refuses loudly rather than returning a wrong number.

## Failure routing — graceful terminal states (CRITICAL #2)

Two stages can fail; both route to `END` via a shared `routeOnFailure(next)` conditional edge,
carrying the partial `traces`:

| Stage    | Trigger                                  | `failure`                                                |
|----------|------------------------------------------|----------------------------------------------------------|
| subgraph | `extractSubgraph` returns `disconnected` | `{ stage:'subgraph', reason:'disconnected' }`            |
| planner  | `planQuery` returns `{ ok:false }`       | `{ stage:'planner', reason:'repair-exhausted' }`         |
| compiler | `compile` throws `CompileError`          | `{ stage:'compiler', reason:<code>, detail }`            |
| execute  | the read-only query rejects              | `{ stage:'execute', reason:'execute-error', detail }`    |

These are graceful terminal states — **not** the constrained-SQL fallback lane (a later brick).
The graph never throws; it surfaces which stage failed plus the trace so far.

## `traces` — the provenance spine

`traces` carries `{ anchor, subgraph, planner, compiler }` slices — the spine the Stage-5
certificate will later consume. It is assembled here even though the certificate isn't built yet.

## Known seam limitation — H2 rewrite vs. recall-favoring S1 (the honest split)

The CRITICAL-#1 derivation is verified end-to-end: for *"total championship points by season"* the
real S1→S2 keeps `driverstandings.points` **with** its `temporalityEvidence` in the payload. But the
snapshot rewrite still does **not** fire end-to-end on that broad payload, because:

1. the `driverstandings→races` calendar edge the fold needs is a **discovered** FK (conf 0.95), so
   under confidence-weighting S2's least-cost tree prefers the **declared** `driverid→drivers` edge
   and never includes the calendar edge (the edge only wins in `uniform` mode); and
2. the fold's grain columns (`driverstandings.driverid`, `races.round`) aren't anchored by a natural
   question, so they'd be trimmed anyway.

Because the evidence survived, the compiler **knows** the column is cumulative and refuses with
`temporality-unreachable` → graceful `failure.stage:'compiler'` — it does **not** emit a naive SUM.
So CRITICAL #1's actual guarantee (no silent wrong aggregate) holds. The rewrite firing is proven
on a tight `{driverstandings, races}` uniform payload fed by the same derivation
(`test/nodes/pipeline.test.ts`, case C). Closing this gap end-to-end (routing/anchoring the calendar
edge) is deferred accuracy work, out of scope for this wiring brick.

A related deferred observation: the recall-favoring S1 + materialize-all-payload-joins compiler can
**over-join** (e.g. the canonical lap-time question pulls `pitstops`/`qualifying`/`results` into the
tree), inflating the aggregate and producing an intractable query that the executor times out on —
surfaced gracefully as `failure.stage:'execute'`. Accuracy/cost tuning is deferred.
