/**
 * Stage 3a — the LLM planner. (question + SubgraphPayload) -> MetricQueryIR.
 *
 * This is the FIRST and ONLY LLM in the NL2SQL pipeline. It is the thinnest possible layer:
 * it chooses WHAT to compute (measure / groupBy / filter / orderBy / limit) and nothing else.
 * It never chooses joins (Stage 2 already did, rendered verbatim by the Stage-3b compiler) and
 * it cannot reference anything outside the payload — the `specializeIrSchema(payload)` leash
 * rejects any out-of-payload IRI.
 *
 * "The LLM chooses, the graph constrains, the compiler writes."
 *
 * Design (see docs/adr/004-llm-planner.md):
 *  - Structured output binds the BASE `MetricQueryIRSchema` (shape only). The payload leash is
 *    enforced as an explicit `specializeIrSchema(payload).safeParse` — NOT via the bound schema.
 *    Reason: the leash is a zod `superRefine` (runtime Set checks) that cannot survive
 *    zod->JSON-Schema conversion, so it can never constrain generation; binding it would only
 *    make leash violations *throw* inside the model call, defeating the no-throw repair loop and
 *    the raw-output trace. The prompt's IRI menu is the real generation-time steer.
 *  - Repair is a BOUNDED async loop (not a LangGraph subgraph): validate -> on failure inject the
 *    zod errors into the next prompt -> retry, with a HARD cap (default 2 retries = 3 attempts).
 *    Being a plain loop it structurally cannot hit LangGraph's `recursion_limit`; on exhaustion it
 *    returns a typed `PlannerFailure` (never an uncaught throw, never a recursion crash).
 *  - Every attempt (raw output + leash errors + whether it validated) is recorded in a structured
 *    trace — the GPT-5-mini failure journal and the observability we want.
 *
 * The trace counts ONLY this outer semantic-leash loop. The inner transient/parse retry inside
 * `StructuredLlm.generate` (`.withRetry`) is a separate layer and never increments an attempt here.
 */
import type { z } from 'zod';
import { MetricQueryIRSchema, specializeIrSchema, type MetricQueryIR } from './ir.js';
import type { SubgraphPayload } from './graph-model.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import { makeRealLlm } from '../llm/client.js';
import { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_V2, buildPlannerPrompt, type RepairContext } from '../prompts/planner.js';

/** GPT-5-mini is the only LLM for the planner; gpt-5 is recognized as a reasoning model by the client. */
const PLANNER_MODEL = 'gpt-5-mini';

/** One semantic-leash attempt (one `generate` call + one `specializeIrSchema.safeParse`). */
export interface PlannerAttempt {
  /** 1-based attempt index within the outer repair loop. */
  attempt: number;
  /** The raw object the model returned (shape-valid; leash UNchecked). */
  raw: unknown;
  /** Whether `raw` passed the payload leash. */
  ok: boolean;
  /** Leash error messages when `ok` is false (zod issue path + message). */
  issues?: string[];
}

export interface PlannerTrace {
  /** Versioned prompt tag (e.g. `planner/v1`). */
  promptVersion: string;
  /** Which schema is the authority for the leash (documents the constraint mechanism). */
  schema: 'specializeIrSchema';
  /** One entry per outer attempt, in order. */
  attempts: PlannerAttempt[];
  outcome: 'ok' | 'repair-exhausted';
}

/** Typed, graceful failure when the bounded repair loop is exhausted — the fallback-lane hook. */
export interface PlannerFailure {
  ok: false;
  reason: 'repair-exhausted';
  trace: PlannerTrace;
}

export interface PlannerSuccess {
  ok: true;
  ir: MetricQueryIR;
  trace: PlannerTrace;
}

export type PlanResult = PlannerSuccess | PlannerFailure;

export interface PlanOptions {
  /** Injected for tests (a deterministic fake). Defaults to the real GPT-5-mini-backed LLM. */
  llm?: StructuredLlm;
  /** Hard cap on RETRIES after the first attempt. Default 2 (= 3 total attempts). */
  maxRetries?: number;
}

/** Render zod issues to compact, model-readable strings for the repair prompt + trace. */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/**
 * Plan a metric query: prompt the LLM for a `MetricQueryIR`, validate it against the payload
 * leash, and repair up to `maxRetries` times before failing gracefully. Returns a discriminated
 * union (`PlanResult`) plus a structured trace — never throws on a leash violation.
 */
export async function planQuery(
  question: string,
  payload: SubgraphPayload,
  opts: PlanOptions = {},
): Promise<PlanResult> {
  const llm = opts.llm ?? makeRealLlm({ model: PLANNER_MODEL });
  const maxRetries = opts.maxRetries ?? 2;
  const leash = specializeIrSchema(payload); // the authority — enforced via safeParse below

  const attempts: PlannerAttempt[] = [];
  let repair: RepairContext | undefined;

  for (let i = 0; i <= maxRetries; i++) {
    const user = buildPlannerPrompt(question, payload, repair);
    // Bind the BASE shape for structured output; the leash is the explicit safeParse below.
    const raw: unknown = await llm.generate(MetricQueryIRSchema, PLANNER_SYSTEM_V2, user);

    const parsed = leash.safeParse(raw);
    if (parsed.success) {
      attempts.push({ attempt: i + 1, raw, ok: true });
      return {
        ok: true,
        ir: parsed.data,
        trace: { promptVersion: PLANNER_PROMPT_VERSION, schema: 'specializeIrSchema', attempts, outcome: 'ok' },
      };
    }

    const issues = formatIssues(parsed.error);
    attempts.push({ attempt: i + 1, raw, ok: false, issues });
    repair = { previous: raw, issues }; // injected into the next prompt
  }

  return {
    ok: false,
    reason: 'repair-exhausted',
    trace: { promptVersion: PLANNER_PROMPT_VERSION, schema: 'specializeIrSchema', attempts, outcome: 'repair-exhausted' },
  };
}
