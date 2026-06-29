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
import { specializeIrSchema, payloadIris, type MetricQueryIR } from '../../src/query/ir.js';
import type { SubgraphPayload } from '../../src/query/graph-model.js';
import { planQuery } from '../../src/query/planner.js';
import { makeFakeLlm, type FakeResponse } from '../../src/llm/structured-llm.js';
import {
  buildPlannerPrompt,
  renderPayloadMenu,
  PLANNER_PROMPT_VERSION,
  PLANNER_SYSTEM_V2,
} from '../../src/prompts/planner.js';
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
    expect(PLANNER_SYSTEM_V2).toContain('do NOT choose joins');
  });
});

describe('Stage 3a — planner: value-grounding filter literals against sampleValues (ADR-009)', () => {
  // Real Stage-2 payloads with the relevant columns retained (anchoring mirrors Stage-1).
  const driversPayload = () => payloadFor(['drivers'], { anchored: { drivers: ['nationality', 'surname', 'driverid'] } });
  const qualifyingPayload = () => payloadFor(['qualifying'], { anchored: { qualifying: ['position'] } });
  const NAT = prop('drivers', 'nationality');

  it('VG1. ungrounded enum value → rejected → option pool surfaced → corrected value passes', async () => {
    const payload = driversPayload();
    // Sanity: nationality is an exhaustive enum carried in full (>15) — value-grounding will fire.
    const nat = payload.classes.flatMap((c) => c.properties).find((p) => p.col === 'nationality')!;
    expect(nat.sampleValues!.length).toBe(nat.distinctCount);
    expect(nat.sampleValues!.length).toBeGreaterThan(15);

    const bad: MetricQueryIR = { select: [{ property: NAT }], filters: [{ property: NAT, op: '=', value: 'Britishish' }] };
    const good: MetricQueryIR = { select: [{ property: NAT }], filters: [{ property: NAT, op: '=', value: 'British' }] };
    const llm = fakeReturning(
      { when: (u) => !u.includes(REPAIR_MARK), respond: () => bad },
      { when: (u) => u.includes(REPAIR_MARK), respond: () => good },
    );

    const res = await planQuery('Japanese drivers', payload, { llm });

    expect(res.trace.attempts[0]!.ok).toBe(false);
    const issue = res.trace.attempts[0]!.issues?.find((i) => i.startsWith('filters.0.value'));
    expect(issue).toBeTruthy();
    expect(issue).toContain('Britishish');
    expect(issue).toContain('British'); // the option pool (real sample values) is surfaced
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.attempts.length).toBe(2);
  });

  it('VG2. grounded value passes; normalized value passes AND is rewritten to the canonical sample', async () => {
    const payload = driversPayload();

    const exact: MetricQueryIR = { select: [{ property: NAT }], filters: [{ property: NAT, op: '=', value: 'British' }] };
    const resExact = await planQuery('q', payload, { llm: fakeReturning({ when: () => true, respond: () => exact }) });
    expect(resExact.ok).toBe(true);

    // 'british' matches only after normalization → accepted AND rewritten to 'British' in the SQL.
    const lower: MetricQueryIR = { select: [{ property: NAT }], filters: [{ property: NAT, op: '=', value: 'british' }] };
    const resLower = await planQuery('q', payload, { llm: fakeReturning({ when: () => true, respond: () => lower }) });
    expect(resLower.ok).toBe(true);
    if (!resLower.ok) return;
    const filter = resLower.ir.filters![0]!;
    expect(filter.value).toBe('British'); // canonical rewrite reached the IR (transform fired, new object)
    const { sql } = compile(resLower.ir, payload);
    expect(sql).toContain("'British'");
    expect(sql).not.toContain("'british'");
  });

  it('VG3. a RANGE op is never value-grounded — qualifying.position >= 16 stays legal', async () => {
    const payload = qualifyingPayload();
    const POS = prop('qualifying', 'position');
    // position IS an exhaustive enum in the fixture; the op-gate (not the column type) is the guard.
    const posCol = payload.classes.flatMap((c) => c.properties).find((p) => p.col === 'position')!;
    expect(posCol.sampleValues!.length).toBe(posCol.distinctCount);
    const ir: MetricQueryIR = { select: [{ property: POS }], filters: [{ property: POS, op: '>=', value: 16 }] };
    const res = await planQuery('drivers eliminated', payload, { llm: fakeReturning({ when: () => true, respond: () => ir }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.attempts.length).toBe(1); // no repair
  });

  it('VG4. a non-enumerable (high-cardinality) column is not grounded — surname filter passes', async () => {
    const payload = driversPayload();
    const SURNAME = prop('drivers', 'surname'); // distinctCount 784, no sampleValues → not enumerable
    const ir: MetricQueryIR = { select: [{ property: SURNAME }], filters: [{ property: SURNAME, op: '=', value: 'Vettel' }] };
    const res = await planQuery('q', payload, { llm: fakeReturning({ when: () => true, respond: () => ir }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.attempts.length).toBe(1);
  });

  it('VG5. a column with no sampleValues (id) is not grounded — passes (safe default)', async () => {
    const payload = driversPayload();
    const ID = prop('drivers', 'driverid');
    const ir: MetricQueryIR = { select: [{ property: ID }], filters: [{ property: ID, op: '=', value: 830 }] };
    const res = await planQuery('q', payload, { llm: fakeReturning({ when: () => true, respond: () => ir }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trace.attempts.length).toBe(1);
  });

  it('VG6. the IRI leash is unchanged — an out-of-payload column still triggers repair (regression)', async () => {
    const payload = newPayload();
    const res = await planQuery('q', payload, { llm: fakeReturning({ when: () => true, respond: () => badIr }) });
    expect(res.trace.attempts[0]!.ok).toBe(false);
    expect(res.trace.attempts[0]!.issues?.some((i) => i.includes('pitstops'))).toBe(true);
    expect(res.trace.attempts.length).toBeGreaterThan(1);
  });
});

describe('Stage 3a — planner menu surfaces column semantics (ADR-010)', () => {
  // dob must be anchored: it has no sampleValues (821 distinct dates, not an enum), so a single-terminal
  // payload would not auto-retain it. The other three mirror Stage-1 anchoring for the assertions.
  const driversPayload = () =>
    payloadFor(['drivers'], { anchored: { drivers: ['dob', 'driverid', 'nationality', 'surname'] } });
  const lineFor = (menu: string, needle: string): string =>
    menu.split('\n').find((l) => l.includes(needle)) ?? '';

  it('M1. surfaces prefLabel + description (the real directional signal) and enumerable samples', () => {
    const menu = renderPayloadMenu(driversPayload());

    // dob is now distinguishable from the PK: prefLabel "Date of birth" + the date RANGE — this is the
    // load-bearing signal (the committed fixture has NO explicit "younger" clause; the label + range is it).
    const dob = lineFor(menu, 'qsl:property/drivers/dob');
    expect(dob).toContain('"Date of birth"');
    expect(dob.toLowerCase()).toContain('date of birth');
    expect(dob).toContain('1896-12-28'); // the date range that marks dob as orderable-by-age
    // Contrast: driverid reads as an ID (range [1..841]) — the planner can now tell them apart.
    const driverid = lineFor(menu, 'qsl:property/drivers/driverid');
    expect(driverid).toContain('"Driver ID"');
    expect(driverid).toContain('[1..841]');

    // nationality (exhaustive 41-value enum) surfaces its option pool; British is in the values.
    const nat = lineFor(menu, 'qsl:property/drivers/nationality');
    expect(nat).toContain('values:');
    expect(nat).toContain('British');
  });

  it('M2. the dob signal reaches the model — buildPlannerPrompt carries prefLabel + description', () => {
    // The planner uses a fake LLM that does not reason over the menu, so we assert the SIGNAL is present
    // (form B). The live behaviour (IR orders by dob ASC) is proven by the `pnpm ask` re-run in the report.
    const prompt = buildPlannerPrompt('who is the oldest driver', driversPayload());
    expect(prompt).toContain('"Date of birth"');
    expect(prompt).toContain("Driver's date of birth");
    expect(prompt).toContain('[1896-12-28..1998-10-29]');
  });

  it('M3. enumerable column shows values; non-enumerable (high-cardinality) does not', () => {
    const menu = renderPayloadMenu(driversPayload());
    // surname: distinctCount 784, no sampleValues → not enumerable → never dumps a value list.
    expect(lineFor(menu, 'qsl:property/drivers/surname')).not.toContain('values:');
    // nationality: exhaustive enum → does.
    expect(lineFor(menu, 'qsl:property/drivers/nationality')).toContain('values:');
  });

  it('M4. menu == leash: the offered IRI set is unchanged (annotations only)', () => {
    const payload = driversPayload();
    const menu = renderPayloadMenu(payload);
    const { properties, capabilities } = payloadIris(payload);
    // Every offered IRI is exactly the leash set — no IRI added or removed by the annotations.
    const offered = new Set([...menu.matchAll(/IRI: (\S+)/g)].map((m) => m[1]!));
    const expected = new Set([...properties, ...capabilities]);
    expect(offered).toStrictEqual(expected);
  });
});

describe('Stage 3a — planner menu surfaces column GRAIN distinguishers (ADR-013)', () => {
  const lineFor = (menu: string, needle: string): string =>
    menu.split('\n').find((l) => l.includes(needle)) ?? '';
  // A temporality tag is `[lowercase words]`; profiled ranges (e.g. `[0..765]`) start with a digit and
  // never match this, so it cleanly distinguishes a real grain tag from a description's numeric range.
  const TEMPORALITY_TAG = /\[[a-z][a-z ]*\]/;

  // The 950 family: two same-surface-name `points` columns whose grain differs. constructorstandings.points
  // carries qsl:temporality "cumulative-snapshot"; constructorresults.points does not (per-row value).
  const pointsPayload = () =>
    payloadFor(['constructorstandings', 'constructorresults'], {
      anchored: { constructorstandings: ['points'], constructorresults: ['points'] },
    });

  it('D1. distinct lines: the cumulative column carries the temporality tag + running-total clause; the per-row column carries its own clause and NO tag', () => {
    const menu = renderPayloadMenu(pointsPayload());

    const cumulative = lineFor(menu, 'qsl:property/constructorstandings/points');
    expect(cumulative).toContain('[cumulative snapshot]');
    expect(cumulative.toLowerCase()).toMatch(/running total|cumulative/);

    const perRow = lineFor(menu, 'qsl:property/constructorresults/points');
    expect(perRow).toContain('per-row value, not a running total');
    expect(perRow).not.toMatch(TEMPORALITY_TAG); // no spurious tag on a column without qsl:temporality

    // The two lines are genuinely distinguishable now (the whole point of the brick).
    expect(cumulative).not.toBe(perRow);
  });

  it('D2. the temporality tag renders only when qsl:temporality is present (general, no hardcoded values)', () => {
    const menu = renderPayloadMenu(pointsPayload());
    expect(lineFor(menu, 'qsl:property/constructorstandings/points')).toContain('[cumulative snapshot]');
    expect(lineFor(menu, 'qsl:property/constructorresults/points')).not.toContain('[cumulative snapshot]');
  });

  it('D3. the distinguishing description clause survives the DESC_CAP (not truncated below the part that distinguishes)', () => {
    const menu = renderPayloadMenu(pointsPayload());
    // The clause that distinguishes per-row from cumulative must reach the model intact.
    expect(lineFor(menu, 'qsl:property/constructorresults/points')).toContain('per-row value, not a running total');
    expect(lineFor(menu, 'qsl:property/constructorstandings/points').toLowerCase()).toContain(
      'not points awarded solely at that race',
    );
  });

  it('D4. non-regression: a payload with no temporality renders no grain tag (existing menu output unchanged)', () => {
    // drivers has no cumulative columns; dob carries a numeric date RANGE that must NOT be read as a tag.
    const menu = renderPayloadMenu(
      payloadFor(['drivers'], { anchored: { drivers: ['dob', 'driverid', 'nationality', 'surname'] } }),
    );
    expect(menu).not.toMatch(/\[(cumulative snapshot|point in time)\]/);
    expect(lineFor(menu, 'qsl:property/drivers/dob')).toContain('1896-12-28'); // the date range still renders
  });

  it('D5. generality: a synthetic non-f1 column renders its temporality tag + description identically (no f1 hardcoding)', () => {
    const synthetic: SubgraphPayload = {
      classes: [
        {
          iri: 'qsl:class/widgets',
          properties: [
            {
              col: 'status',
              prefLabel: 'Status',
              temporality: 'point-in-time',
              description: 'current snapshot status (not the historical value)',
            },
          ],
        },
      ],
      joins: [],
      capabilities: [],
      aggregateConfidence: 1,
      bridgeNodes: [],
      totalCost: 0,
    };
    const line = lineFor(renderPayloadMenu(synthetic), 'qsl:property/widgets/status');
    expect(line).toContain('[point in time]'); // hyphen→space, generic for any DB's temporality value
    expect(line).toContain('current snapshot status (not the historical value)');
  });

  it('D6. ADR-015: an as-of-event-snapshot value renders [as of event snapshot] (the position-family grain distinguisher reaches the menu)', () => {
    // The generator now tags standings `position` columns `as-of-event-snapshot` (ADR-015). The renderer
    // is value-agnostic, so the new tag surfaces with no renderer change — making the position family,
    // previously tag-blind, distinguishable from a per-event sibling in the menu.
    const synthetic: SubgraphPayload = {
      classes: [
        {
          iri: 'qsl:class/driverstandings',
          properties: [
            { col: 'position', prefLabel: 'Standing position', temporality: 'as-of-event-snapshot', description: 'championship rank as-of the race' },
          ],
        },
      ],
      joins: [],
      capabilities: [],
      aggregateConfidence: 1,
      bridgeNodes: [],
      totalCost: 0,
    };
    const line = lineFor(renderPayloadMenu(synthetic), 'qsl:property/driverstandings/position');
    expect(line).toContain('[as of event snapshot]');
  });

  it('D7. end-to-end: the regenerated fixture surfaces [as of event snapshot] on the standings position, not on the per-event sibling', () => {
    // Real Stage-2 payload from the committed (ADR-015-regenerated) fixture: the standings position
    // carries the as-of-event-snapshot tag, the per-event results.position carries none. This is the
    // position-family menu becoming grain-NON-blind (the tier-2 deliverable reaching SQL-gen input).
    const menu = renderPayloadMenu(
      payloadFor(['driverstandings', 'results'], {
        anchored: { driverstandings: ['position'], results: ['position'] },
      }),
    );
    const standings = lineFor(menu, 'qsl:property/driverstandings/position');
    const perEvent = lineFor(menu, 'qsl:property/results/position');
    expect(standings).toContain('[as of event snapshot]');
    expect(perEvent).not.toContain('[as of event snapshot]');
    expect(standings).not.toBe(perEvent); // genuinely distinguishable now
  });
});

describe('Stage 3a — planner: generalized shapes (projection) + leash covers select', () => {
  it('7. a projection IR passes the leash and compiles; an out-of-payload select column triggers repair', async () => {
    const payload = newPayload();

    // In-payload projection: read a column the payload exposes (no measures).
    const goodProjection: MetricQueryIR = { select: [{ property: prop('constructors', 'nationality') }] };
    const llmGood = fakeReturning({ when: () => true, respond: () => goodProjection });

    const res = await planQuery('list the constructor nationalities', payload, { llm: llmGood });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(specializeIrSchema(payload).safeParse(res.ir).success).toBe(true);
    const { sql } = compile(res.ir, payload);
    expect(sql).toContain('SELECT constructors.nationality');
    expect(sql).not.toMatch(/\b(AVG|SUM|COUNT|MIN|MAX)\s*\(/);

    // Out-of-payload select column → first attempt fails the leash on the `select` path, repair fires.
    const badProjection: MetricQueryIR = { select: [{ property: prop('pitstops', 'duration') }] };
    const llmBad = fakeReturning({ when: () => true, respond: () => badProjection });

    const res2 = await planQuery('q', payload, { llm: llmBad });
    expect(res2.trace.attempts[0]!.ok).toBe(false);
    expect(res2.trace.attempts[0]!.issues?.some((i) => i.includes('pitstops'))).toBe(true);
    expect(res2.trace.attempts.length).toBeGreaterThan(1);
  });
});
