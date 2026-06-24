# Stage 3a — the LLM planner

`planQuery(question, payload, opts?) → PlanResult` ([src/query/planner.ts](../../src/query/planner.ts))

The planner is the **first and only LLM** in the NL2SQL pipeline
(anchoring → subgraph extraction → **planner** → compiler → execute). It is deliberately the
thinnest possible layer.

## Job: choose *what to compute*, nothing else

Given a question and a Stage-2 `SubgraphPayload`, the planner emits a typed `MetricQueryIR`
choosing only the **measure / groupBy / filter / orderBy / limit**. It does **not**:

- **choose joins** — Stage 2 already did; the compiler renders `payload.joins` verbatim. The IR
  grammar has no join field, so the planner *cannot* express one, and it never mutates the payload.
- **reference anything outside the payload** — the leash (below) rejects any out-of-payload IRI.
- **write SQL** — the deterministic compiler ([compiler.md](compiler.md)) does that.

"The LLM chooses, the graph constrains, the compiler writes."

## The leash: `specializeIrSchema(payload)`, enforced by explicit `safeParse`

`specializeIrSchema(payload)` ([src/query/ir.ts](../../src/query/ir.ts)) narrows the IR schema so the
only legal property/capability IRIs are those derivable from the payload.

The planner binds the **base** `MetricQueryIRSchema` (shape only) to the model's structured output,
then enforces the leash as a **separate, explicit** `specializeIrSchema(payload).safeParse(raw)`.
It does **not** bind the specialized schema to structured output. Why:

- The leash is a zod `superRefine` (runtime `Set` membership checks). Those checks **cannot survive
  zod → JSON-Schema conversion**, so binding the specialized schema would constrain *nothing* extra
  at generation time anyway.
- Binding it would instead make leash violations **throw inside the model call**, which would defeat
  the no-throw repair loop and the raw-output trace.

So generation is steered by the **prompt's IRI menu** (built from `payloadIris(payload)`, so the menu
equals the leash by construction), and the narrowed schema remains the authority — at the validate
step, which is exactly where the repair loop reads it.

## Value-grounding: filter literals must be real values ([ADR-009](../adr/009-value-grounding.md))

The leash also constrains filter **values**, not just IRIs. The IRI leash stops the planner inventing
a *column*; value-grounding stops it inventing a *value* for that column — the documented
`results.positiontext = 'eliminated in first period'` hallucination (a string that exists in no row →
zero results). It is the SQL-side of READS's *constrained option pool*: the planner must **select** a
real value, not generate one.

**When it fires (all must hold):**
- the op is **equality/membership** — `=`, `!=`, `IN` (NOT a range/pattern op `<`/`<=`/`>`/`>=`/`LIKE`);
- the value is a **string** (or, for `IN`, strings) — numbers (ids/years) are never grounded;
- the column is **enumerable**: it carries `sampleValues` AND `distinctCount <= sampleValues.length`
  (the payload holds the column's *full* domain). This predicate is **self-protecting** — if the
  samples were ever truncated it is false, so a real-but-unlisted value is never wrongly rejected.

**What happens:**
- exact match against a sample → pass.
- match only after `normalize()` (case/diacritic/punct fold, reusing
  [text-normalize.ts](../../src/query/text-normalize.ts)) → pass, and the value is **rewritten** to
  the canonical sample (`'british'` → `'British'`) by a trailing `transform` on the specialized schema
  (it runs only on a successful parse, so every grounded literal is guaranteed to match).
- no match on an enumerable column → **rejected** with the option pool (the sample list, capped at 15)
  surfaced in the issue message, feeding the same repair loop below — no change to the repair plumbing.

**When it skips (the safe default):** range/pattern op, numeric value, non-enumerable /
high-cardinality column, or a column with no samples. So `qualifying.position >= 16` stays legal (range
op — even though `position` *is* enumerable; the op-gate, not the column type, is the guard), and a
`drivers.surname = 'Vettel'` filter passes untouched (784 distinct, no samples → not enumerable).
Grounding applies to filters on **terminal** classes, where `sampleValues` live.

## The bounded repair loop

A plain async loop (not a LangGraph subgraph):

1. Build the prompt (with the previous leash errors injected on a retry).
2. `raw = llm.generate(MetricQueryIRSchema, system, user)`.
3. `specializeIrSchema(payload).safeParse(raw)`:
   - **valid** → return `{ ok: true, ir, trace }`.
   - **invalid, retries left** → inject the zod issues into the next prompt and retry.
   - **invalid, exhausted** → return a typed `{ ok: false, reason: 'repair-exhausted', trace }`.

The attempt counter has a **hard cap** (`maxRetries`, default 2 → 3 total attempts).

**Recursion-limit caveat.** A LangGraph repair subgraph must cap attempts *below* LangGraph's
`recursion_limit` (default 25) or an unbounded repair cycle hits the recursion ceiling and *crashes*
instead of failing gracefully. We use a plain bounded loop precisely so this cannot happen — it
returns a typed `PlannerFailure`, never an uncaught throw and never a recursion crash. The caveat is
recorded here for the future, should the loop ever be reimplemented as a subgraph.

**Two retry layers — keep them distinct.** `StructuredLlm.generate` wraps `.withRetry({stopAfterAttempt:2})`
for *transient/parse* failures. That is a separate, inner layer. `PlannerTrace.attempts` counts **only**
the outer *semantic-leash* loop — one entry per `generate` call — so the attempt counts stay clean.

## Trace (the GPT-5-mini failure journal)

Every attempt records `{ attempt, raw, ok, issues? }`; the trace also carries `promptVersion`,
`schema: 'specializeIrSchema'`, and `outcome`. See
[docs/experiments/planner-failures.md](../experiments/planner-failures.md).

## Prompt versioning

The system prompt is a versioned constant `PLANNER_SYSTEM_V1` tagged `PLANNER_PROMPT_VERSION`
(`planner/v1`) in [src/prompts/planner.ts](../../src/prompts/planner.ts); the tag is carried in the
trace. Field semantics live in the prompt (not as zod `.describe()`) so the verified `ir.ts` stays
untouched. The prompt iterates under new version tags.
