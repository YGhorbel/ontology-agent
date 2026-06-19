/**
 * Stage 3a acceptance gate — the LLM planner, with the model MOCKED (deterministic, no network,
 * no API key). Tests the PLUMBING (leash validation + bounded repair + trace + the planner→compiler
 * seam), NOT the model's intelligence. Payloads are REAL Stage-2 payloads from the committed
 * formula1 fixture (via `payloadFor`); the IRs are hand-written canned fake-model outputs.
 *
 * The "invalid" canned output is SHAPE-valid (passes the base MetricQueryIRSchema that
 * `makeFakeLlm` re-parses) but LEASH-invalid (references `pitstops.duration`, a property not in
 * the {laptimes, constructors} payload) — exactly the failure the leash + repair loop exist for.
 */
import { describe, it, expect } from 'vitest';
import { compile } from '../../src/query/compiler.js';
import { specializeIrSchema, type MetricQueryIR } from '../../src/query/ir.js';
import { planQuery } from '../../src/query/planner.js';
import { makeFakeLlm, type FakeResponse } from '../../src/llm/structured-llm.js';
import { buildPlannerPrompt, PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_V1 } from '../../src/prompts/planner.js';
import { payloadFor, prop, ir1, CAP_AVG_LAP_MS } from '../fixtures/ir/index.js';

const newPayload = () => payloadFor(['laptimes', 'constructors'], { anchored: { constructors: ['nationality'] } });

/** Shape-valid but out-of-payload (pitstops is not in this tree) → passes base schema, fails the leash. */
const badIr: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'AVG', property: prop('pitstops', 'duration') }, alias: 'bad' }],
};

const REPAIR_MARK = 'PREVIOUS_ATTEMPT_FAILED';
const fakeReturning = (...responses: FakeResponse[]) => makeFakeLlm(responses);

describe('Stage 3a — planner: happy path → valid IR feeds the compiler', () => {
  it('1. returns a leash-valid IR that compiles to SQL (the planner→compiler seam)', async () => {
    const payload = newPayload();
    const llm = fakeReturning({ when: () => true, respond: () => ir1 });

    const res = await planQuery('avg lap time by constructor nationality, British only', payload, { llm });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(specializeIrSchema(payload).safeParse(res.ir).success).toBe(true);

    const { sql } = compile(res.ir, payload);
    expect(sql).toContain('AVG(laptimes.milliseconds)');
    expect(sql).toContain('GROUP BY constructors.nationality');
  });
});

describe('Stage 3a — planner: the leash rejects an out-of-payload IRI', () => {
  it('2. a property IRI not in the payload fails validation and triggers repair', async () => {
    const payload = newPayload();
    const llm = fakeReturning({ when: () => true, respond: () => badIr });

    const res = await planQuery('q', payload, { llm });

    // First attempt rejected by the leash, and the loop re-invoked the model (repair triggered).
    expect(res.trace.attempts[0]!.ok).toBe(false);
    expect(res.trace.attempts[0]!.issues?.some((i) => i.includes('pitstops'))).toBe(true);
    expect(res.trace.attempts.length).toBeGreaterThan(1);
  });
});

describe('Stage 3a — planner: bounded repair succeeds on the second attempt', () => {
  it('3. invalid then valid → returns the valid IR; trace shows one failed + one successful attempt', async () => {
    const payload = newPayload();
    const llm = fakeReturning(
      { when: (u) => !u.includes(REPAIR_MARK), respond: () => badIr },
      { when: (u) => u.includes(REPAIR_MARK), respond: () => ir1 },
    );

    const res = await planQuery('q', payload, { llm });

    expect(res.ok).toBe(true);
    expect(res.trace.outcome).toBe('ok');
    expect(res.trace.attempts.length).toBe(2);
    expect(res.trace.attempts[0]!.ok).toBe(false);
    expect(res.trace.attempts[1]!.ok).toBe(true);
  });
});

describe('Stage 3a — planner: repair exhausts → graceful typed failure', () => {
  it('4. always-invalid → stops at the cap, returns PlannerFailure (no throw, no recursion crash)', async () => {
    const payload = newPayload();
    const llm = fakeReturning({ when: () => true, respond: () => badIr });

    const res = await planQuery('q', payload, { llm }); // default maxRetries = 2 → 3 attempts

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('repair-exhausted');
    expect(res.trace.outcome).toBe('repair-exhausted');
    expect(res.trace.attempts.length).toBe(3);
    expect(res.trace.attempts.every((a) => !a.ok)).toBe(true);
  });
});

describe('Stage 3a — planner: no-join invariant (join authority stays with Stage 2)', () => {
  it('5. an emitted join-like key never reaches the IR, and the payload is never mutated', async () => {
    const payload = newPayload();
    const before = JSON.stringify(payload);
    // The IR grammar has no join field; a stray `joins` key is stripped by the schema, never honored.
    const withJoins = { ...ir1, joins: [{ from: 'qsl:class/laptimes', to: 'qsl:class/constructors' }] };
    const llm = fakeReturning({ when: () => true, respond: () => withJoins });

    const res = await planQuery('q', payload, { llm });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('joins' in res.ir).toBe(false);
    expect(JSON.stringify(payload)).toBe(before); // planner read the payload, never mutated it
  });
});

describe('Stage 3a — planner: prompt is versioned + payload-scoped', () => {
  it('6. trace carries the version tag; the rendered prompt is the payload menu and forbids joins', async () => {
    const payload = newPayload();
    const llm = fakeReturning({ when: () => true, respond: () => ir1 });

    const res = await planQuery('q', payload, { llm });
    expect(res.trace.promptVersion).toBe(PLANNER_PROMPT_VERSION);
    expect(res.trace.schema).toBe('specializeIrSchema');

    const prompt = buildPlannerPrompt('q', payload);
    // The model is handed the menu (its capability + a property of the payload)…
    expect(prompt).toContain(CAP_AVG_LAP_MS);
    expect(prompt).toContain('constructors.nationality');
    // …but is instructed NOT to emit joins (both in the rendered prompt and the system prompt).
    expect(prompt).toContain('DO NOT emit joins');
    expect(PLANNER_SYSTEM_V1).toContain('do NOT choose joins');
  });
});
