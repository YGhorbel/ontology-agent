# ADR 004 — The LLM planner (Stage 3a)

Status: accepted · Supersedes/relates: [003-ir-and-compiler](003-ir-and-compiler.md),
[002-subgraph-extraction](002-subgraph-extraction.md)

## Context

Stage 2 (subgraph extraction) and Stage 3b (the compiler) are deterministic and verified. We need a
single LLM step between them that turns a question + a `SubgraphPayload` into a typed `MetricQueryIR`.
It must choose only *what to compute*, never joins, and never reference anything outside the payload.
This is the first LLM in the system, so robustness and observability matter more than cleverness.

## Decision 1 — Structured output over a *base*-shape schema; leash via explicit `safeParse`

The planner binds the base `MetricQueryIRSchema` (shape only) to the model's structured output, and
enforces the payload leash (`specializeIrSchema(payload)`) as a **separate explicit `safeParse`**.

Rationale: the leash is implemented as a zod `superRefine` (runtime `Set` checks), which is **not
expressible in JSON Schema** — so it cannot constrain generation regardless of where we bind it.
Binding the specialized schema would only change *failure mode*: leash violations would **throw inside
the model invocation** (and inside the test fake's re-parse), defeating the no-throw repair loop and
the raw-output trace. Enforcing the leash as an explicit `safeParse` gives us the raw output, the
structured zod errors to feed the repair prompt, and graceful control flow. The prompt's IRI menu
(derived from `payloadIris`, so menu == leash) is the real generation-time steer.

Consequence: this diverges from the literal "the narrowed schema *is* the structured-output schema"
framing, but is the only design that satisfies the no-throw + raw-trace + bounded-repair requirements
without modifying the verified `specializeIrSchema`. (A future enum-based leash *could* constrain
generation; out of scope here.)

## Decision 2 — A bounded state loop, not unbounded retry, and not a LangGraph subgraph

Repair is a plain async loop with a hard attempt cap (default 2 retries = 3 attempts). On each failure
the zod issues are injected into the next prompt; on exhaustion it returns a typed `PlannerFailure`
(the fallback-lane hook) rather than throwing.

We chose a plain loop over a LangGraph subgraph because the planner's repair is internal plumbing, not
pipeline routing; a plain loop is trivially deterministic/mockable and **structurally cannot hit
LangGraph's `recursion_limit`** (a subgraph repair cycle that out-runs the cap would crash on the
recursion ceiling instead of failing gracefully — the caveat we explicitly avoid).

## Decision 3 — A structured failure journal

Every attempt (raw model output + leash errors + pass/fail) plus the prompt version is recorded in a
`PlannerTrace`. This is the GPT-5-mini failure journal
([docs/experiments/planner-failures.md](../experiments/planner-failures.md)) and the observability we
want before any accuracy work. The exit gate for this stage is "schema-valid IR with a working repair
path on hand-written, mocked cases" — accuracy moves to the gold/benchmarking sprint.

## Out of scope

Gold/e2e/accuracy; real LLM in tests; the fallback lane (only the typed hook exists); a ReAct/agent
abstraction (a single constrained structured-output call + an explicit bounded loop is intentional).
