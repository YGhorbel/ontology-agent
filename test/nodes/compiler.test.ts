/**
 * Stage 3b acceptance gate — the deterministic compiler over REAL Stage-2 payloads.
 * No LLM, no DB. The gate is parse-check (the compiler parses its own output with the
 * same pgsql-ast-parser the formula validator uses); SQL is asserted structurally.
 *
 * Payloads are produced by the genuine extractor on the committed formula1 fixture, so
 * every test asserts the compiler's behaviour against actual ontology data — not prose.
 */
import { describe, it, expect } from 'vitest';
import { parse } from 'pgsql-ast-parser';
import { compile, CompileError } from '../../src/query/compiler.js';
import { specializeIrSchema, type MetricQueryIR } from '../../src/query/ir.js';
import {
  payloadFor,
  classIriOf,
  prop,
  ir1,
  ir2,
  ir4cumulative,
  ir4perRace,
  ir6numericText,
  ir6numeric,
  CAP_AVG_LAP_MS,
} from '../fixtures/ir/index.js';
import { tableOfClassIri } from '../../src/query/graph-build.js';

const parses = (sql: string): boolean => {
  try {
    parse(sql);
    return true;
  } catch {
    return false;
  }
};
const joinCount = (sql: string): number => (sql.match(/\bJOIN\b/g) ?? []).length;

describe('Stage 3b — compiler: simple metric over declared joins', () => {
  it('1. renders the capability AVG, the payload joins VERBATIM (no more, no fewer), WHERE + GROUP BY', () => {
    const payload = payloadFor(['laptimes', 'constructors'], { anchored: { constructors: ['nationality'] } });
    const { sql } = compile(ir1, payload);

    expect(sql).toContain('AVG(laptimes.milliseconds)');
    expect(sql).toContain('GROUP BY constructors.nationality');
    expect(sql).toContain("constructors.nationality = 'British'");

    // Exactly the payload's joins — count AND literal ON pairs (catches silent re-derivation).
    expect(joinCount(sql)).toBe(payload.joins.length);
    for (const j of payload.joins) {
      const from = tableOfClassIri(j.from);
      const to = tableOfClassIri(j.to);
      const on = j.on.map(([a, b]) => `${from}.${a} = ${to}.${b}`).join(' AND ');
      expect(sql).toContain(`ON ${on}`);
    }
    expect(parses(sql)).toBe(true);
  });
});

describe('Stage 3b — compiler: composite join rendering (RULE B)', () => {
  it('2. emits a 2-column AND join condition on (driverid, raceid) and parses', () => {
    const payload = payloadFor(['laptimes', 'driverstandings'], {
      uniform: true,
      anchored: { laptimes: ['milliseconds'] },
    });
    // Sanity: the chosen edge really is the composite (2 column pairs).
    expect(payload.joins.length).toBe(1);
    expect(payload.joins[0]!.on.length).toBe(2);

    const { sql } = compile(ir2, payload);
    expect(sql).toMatch(
      /ON laptimes\.(driverid|raceid) = driverstandings\.(driverid|raceid) AND laptimes\.(driverid|raceid) = driverstandings\.(driverid|raceid)/,
    );
    expect(sql).toContain('laptimes.driverid = driverstandings.driverid');
    expect(sql).toContain('laptimes.raceid = driverstandings.raceid');
    expect(parses(sql)).toBe(true);
  });
});

describe('Stage 3b — compiler: scope-coherence rejection', () => {
  it('3. throws CompileError citing the table a capability formula references but the payload lacks', () => {
    const base = payloadFor(['laptimes', 'constructors'], { anchored: { constructors: ['nationality'] } });
    // Inject a capability whose formula references `pitstops` — NOT in this tree (simulates the
    // generator-era `fastest-lap-time-from-lap-records` scope bug the guard exists for).
    const payload = {
      ...base,
      capabilities: [
        ...base.capabilities,
        {
          iri: 'qsl:capability/metric/laptimes/bad-scope',
          kind: 'metric',
          scopeClass: classIriOf('laptimes'),
          formulaHint: 'AVG(pitstops.duration)',
        },
      ],
    };
    const ir: MetricQueryIR = { measures: [{ capability: 'qsl:capability/metric/laptimes/bad-scope' }] };

    expect(() => compile(ir, payload)).toThrow(CompileError);
    try {
      compile(ir, payload);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as CompileError).code).toBe('scope-table');
      expect((e as CompileError).offending).toBe('pitstops');
    }
  });
});

describe('Stage 3b — compiler: cumulative-snapshot rewrite (H2 mechanism)', () => {
  it('4. de-cumulates a cumulative column (calendar fold), but plain-SUMs a per-race column', () => {
    // DIVERGENCE from plan prose: driverstandings→races is a DISCOVERED FK (conf 0.95) on raceid, not a
    // declared one — so confidence-mode routing takes the zero-cost declared detour (via drivers, laptimes)
    // and never makes races adjacent. Uniform mode picks the 1-hop discovered edge, sourcing year/round
    // directly. Same fold mechanism; only the H1 routing knob differs.
    // Anchor the grain columns too: `driverid` is on driverstandings but is not a join key here, so it would
    // otherwise be trimmed away — the de-cumulation needs it for PARTITION BY.
    const payload = payloadFor(['driverstandings', 'races'], {
      uniform: true,
      anchored: { driverstandings: ['points', 'driverid'], races: ['year', 'round'] },
    });

    // PRE-ASSERT at the payload: the enriched temporalityEvidence survived the anchored-column trim path.
    const ds = payload.classes.find((c) => c.iri === classIriOf('driverstandings'))!;
    const points = ds.properties.find((p) => p.col === 'points')!;
    expect(points.temporality).toBe('cumulative-snapshot');
    expect(points.temporalityEvidence).toBeDefined();
    expect(points.temporalityEvidence!.partitionColumns).toEqual(['driverid', 'year']);
    expect(points.temporalityEvidence!.orderColumn).toBe('round');

    const { sql } = compile(ir4cumulative, payload);
    // Snapshot rewrite present, partition per (driver, season), ordered by round desc.
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY driverstandings.driverid, races.year ORDER BY races.round DESC)');
    expect(sql).toContain('__qsl_snap_rn = 1');
    // The calendar table is folded in via the payload's declared FK — sourcing year/round.
    expect(sql).toContain('JOIN races ON driverstandings.raceid = races.raceid');
    // Grouping is on the season, re-qualified to the folded alias.
    expect(sql).toContain('GROUP BY driverstandings.year');
    expect(parses(sql)).toBe(true);

    // Contrast: results.points is per-race → a plain SUM, no window, no fold.
    const perRace = payloadFor(['results'], { anchored: { results: ['points'] } });
    const { sql: sql2 } = compile(ir4perRace, perRace);
    expect(sql2).toContain('SUM(results.points)');
    expect(sql2).not.toContain('ROW_NUMBER');
    expect(sql2).not.toContain('__qsl_snap_rn');
    expect(parses(sql2)).toBe(true);
  });
});

describe('Stage 3b — compiler: specialized-schema constraint (the planner leash)', () => {
  it('5. specializeIrSchema accepts in-payload IRIs and rejects out-of-payload ones', () => {
    const payload = payloadFor(['laptimes', 'constructors'], { anchored: { constructors: ['nationality'] } });
    const schema = specializeIrSchema(payload);

    expect(schema.safeParse(ir1).success).toBe(true);

    const badProp: MetricQueryIR = {
      measures: [{ aggExpr: { fn: 'AVG', property: prop('pitstops', 'duration') }, alias: 'x' }],
    };
    expect(schema.safeParse(badProp).success).toBe(false);

    const badCap: MetricQueryIR = { measures: [{ capability: 'qsl:capability/metric/seasons/made-up' }] };
    expect(schema.safeParse(badCap).success).toBe(false);

    // A real, in-payload capability validates.
    const okCap: MetricQueryIR = { measures: [{ capability: CAP_AVG_LAP_MS }] };
    expect(schema.safeParse(okCap).success).toBe(true);
  });
});

describe('Stage 3b — compiler: numeric-text cast', () => {
  it('6. CASTs a numeric-text column used numerically; leaves a real numeric column uncast', () => {
    const payload = payloadFor(['pitstops'], { anchored: { pitstops: ['duration', 'milliseconds'] } });

    const { sql } = compile(ir6numericText, payload);
    expect(sql).toContain('AVG(CAST(pitstops.duration AS numeric))');
    expect(sql).toContain('CAST(pitstops.duration AS numeric) > 20000');
    expect(parses(sql)).toBe(true);

    const { sql: sql2 } = compile(ir6numeric, payload);
    expect(sql2).toContain('AVG(pitstops.milliseconds)');
    expect(sql2).not.toContain('CAST');
    expect(parses(sql2)).toBe(true);
  });
});
