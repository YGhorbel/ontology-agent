import { describe, it, expect } from 'vitest';
import { computeRVES, rewardForRecord, vesReward } from '../src/ves.js';
import type { RunRecord } from '../src/types.js';

describe('vesReward — faithful to mini_dev threshold table', () => {
  it('maps time ratios to the published reward steps', () => {
    expect(vesReward(0)).toBe(0); // signals not-timed / incorrect
    expect(vesReward(2)).toBe(1.25);
    expect(vesReward(3)).toBe(1.25);
    expect(vesReward(1)).toBe(1);
    expect(vesReward(1.9)).toBe(1);
    expect(vesReward(0.5)).toBe(0.75);
    expect(vesReward(0.9)).toBe(0.75);
    expect(vesReward(0.25)).toBe(0.5);
    expect(vesReward(0.49)).toBe(0.5);
    expect(vesReward(0.1)).toBe(0.25);
  });
});

function rec(p: Partial<RunRecord>): RunRecord {
  return {
    id: 'x', dbName: 'd', stratum: 's', question: 'q', goldSql: 'g', candidateSql: 'c',
    executionMatchStrict: true, executionMatch: true, softF1: 1,
    latencyMs: 1, tokens: { prompt: 0, completion: 0 }, artifacts: {},
    ...p,
  };
}

describe('rewardForRecord — gated on strict EX + needs timings', () => {
  it('zero unless execution-correct', () => {
    expect(rewardForRecord(rec({ executionMatchStrict: false, goldExecMs: 10, candExecMs: 5 }))).toBe(0);
  });
  it('zero when timings are missing', () => {
    expect(rewardForRecord(rec({ executionMatchStrict: true }))).toBe(0);
  });
  it('faster candidate earns a higher reward', () => {
    // gold 10ms / cand 4ms = ratio 2.5 → reward 1.25
    expect(rewardForRecord(rec({ goldExecMs: 10, candExecMs: 4 }))).toBe(1.25);
    // gold 10ms / cand 12ms = ratio 0.83 → reward 0.75
    expect(rewardForRecord(rec({ goldExecMs: 10, candExecMs: 12 }))).toBe(0.75);
  });
});

describe('computeRVES — mean(sqrt(reward)*100)', () => {
  it('matches compute_ves over a small set', () => {
    const records = [
      rec({ goldExecMs: 10, candExecMs: 4 }), // ratio 2.5 → reward 1.25
      rec({ goldExecMs: 10, candExecMs: 10 }), // ratio 1 → reward 1
      rec({ executionMatchStrict: false }), // reward 0
    ];
    const expected = (Math.sqrt(1.25) * 100 + Math.sqrt(1) * 100 + 0) / 3;
    expect(computeRVES(records)).toBeCloseTo(expected, 9);
  });
  it('empty set → 0', () => {
    expect(computeRVES([])).toBe(0);
  });
});
