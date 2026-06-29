# ADR-012 — Back-prune the FROM clause to IR-referenced tables

**Status:** accepted · **Stage:** 3b (deterministic compiler) · **Supersedes nothing; refines ADR-003**

## Context

The first end-to-end benchmark (12.5% execution accuracy on formula1/f1-draft) showed that the
**dominant failure mode is over-joining**: the compiler's `buildFrom` emitted *every* table in the
Stage-2 `SubgraphPayload` as an INNER JOIN, regardless of whether the planner's IR referenced it.

The payload is the cheapest Steiner tree connecting the anchored terminals (ADR-002). That tree
routinely carries tables the IR never reads from:

- a **kept terminal** that anchoring speculatively pulled in but the planner didn't use, or
- a **Steiner bridge** that only exists to connect other terminals.

Rendering such a table as an INNER JOIN silently constrains the row population — e.g. "which country
is the oldest driver from" over a `{drivers, laptimes}` payload joins `laptimes`, so the answer spans
only drivers who set a lap time, not all drivers. The planner committed to a single-table projection;
the compiler quietly widened it. That violates the architecture's invariant: **"the LLM chooses, the
graph constrains, the compiler writes"** — the compiler must write *what the plan committed to*, not
what retrieval speculatively retrieved.

The over-join split analysis ([docs/diagnosis/overjoin-split.md](../diagnosis/overjoin-split.md))
quantified the population-corrupting over-joins by recomputing from the benchmark's predicted SQL.

## Decision

After the planner emits the IR, **restrict the FROM to the minimal connected subtree of the existing
payload tree that spans exactly the tables the IR references** — drop every other table and its
joins. This is compiler-only and *sub-selects* the tree Stage 2 already produced; it never re-routes,
re-weights, or recomputes a Steiner tree.

### Algorithm

1. **Referenced-table set** (`referencedTables`): the table named by each IR slot — `select`,
   `groupBy`, `filters`, `orderBy.byProperty`; each `measures[].aggExpr` column; and the table(s) a
   capability `formulaHint` references via `referencedColumns()` (falling back to the capability's
   scope table for a column-free `COUNT(*)`-style formula, mirroring the formula validator's
   `fromTables`). Join keys are *not* referenced — they appear only in generated `ON` clauses. A
   reference to a calendar table folded away by the temporality pass maps to its **measure table**
   (`requiredTableFor`), mirroring `refExpr`, so the prune operates purely on the post-fold outer
   tree and never fights de-cumulation. `referencedTables` runs after the fold pass, before `buildFrom`.
2. **Minimal connected subtree** (`minimalSubtree`) by **leaf-pruning**: the post-fold outer joins
   form a tree; repeatedly drop any degree-1 node not in the referenced set (and its incident edge)
   until none remain. On a tree this yields the unique minimal connected subtree spanning the
   referenced nodes. `buildFrom` then emits FROM/JOINs over exactly the kept nodes/edges.

### Connectivity correctness (the must-not-break argument)

Leaf-pruning only ever removes a **degree-1 node not in the referenced set**. A non-referenced node
that lies on the (unique, tree) path between two referenced nodes has degree ≥2, so it is never a
leaf and is never dropped — it is an **articulation point** and is structurally retained. Therefore
the kept subgraph is always connected and always spans the referenced tables. This is the one place a
bug would turn an over-join into a *broken* (disconnected / wrong) query; the leaf-pruning
formulation forbids it by construction. (Same idea as `pruneLeaves` in `subgraph.ts`, on the payload
join shape rather than `JoinEdge`.)

## Measured expectation (calibrate success to THIS, not to EA)

From the split analysis (33 population-corrupting over-joins):

- **12** are fully fixable by this brick — all bad tables UNREFERENCED *and* dropping them keeps the
  referenced tables connected: ids **847, 854, 859, 868, 880, 894, 915, 964, 967, 971, 988, 1011**
  (+ up to 3 fan-out execute-errors 879/959/972 that may become runnable).
- Of those 12, only **2** flip to a match (**915, 971**); the other 10 carry a co-occurring defect
  (wrong column, dropped filter, IR-can't-express). So **EA moves only ~2–3**.
- **21/33 are OUT OF SCOPE** and deferred to the next (grain) design: **12** where the IR *references*
  the bad table (wrong-grain bucket: 865, 881, 904, 928, 937, 944, 950, 954, 955, 963, 989, 1003) and
  **9** where the bad table is an **articulation point** the FROM structurally needs (862, 866, 877,
  931, 940, 951, 960, 990, 1002). This brick must NOT try to fix these.

**Re-benchmark success metric (separate follow-up): the over-join count drops by ~12 and FROM table
counts shrink toward gold on those 12, while EA rises ~2–3.** Fixing materially more than ~12
over-joins signals a dropped-needed-table bug; an EA jump signals a matcher problem.

## Consequences

- **+** Removes population corruption from ~12 over-joins; makes the other failure buckets measurable
  in isolation; restores the compiler invariant. The 915/971 queries collapse to single-table
  `drivers`.
- **−** Headline EA barely moves (~2–3) — the value is structural, not accuracy, this round.
- **Non-regression:** a payload where every table is referenced prunes nothing → byte-identical FROM
  (this is why the already-passing benchmark questions stay passing). Existing composite-join coverage
  (`ir2`) was updated so its IR genuinely references the joined table — otherwise back-prune would
  correctly drop it.
- **Unchanged:** anchoring, pruning, superlative grounding, Steiner extraction, planner, the leash,
  the IR shape, the ontology, the generator, join cost/weights, and how a kept join renders.

## Tests

`test/nodes/compiler.test.ts` (real Stage-2 payloads, parse-checked, no LLM/DB): unreferenced bridge
dropped (915 collapse); **articulation bridge KEPT** (the must-not-break guard); referenced fact
table kept (over-prune guard); 3-of-6 minimal subtree (off-path leaf dropped, stays connected);
no-op on already-minimal payload (non-regression, asserted via the absent `back-prune` trace entry);
join-key-only table dropped.
