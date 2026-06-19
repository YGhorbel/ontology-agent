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
