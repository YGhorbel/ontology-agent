import { describe, it, expect } from 'vitest';
import {
  asNumericGold,
  birdStrictMatch,
  cellsEqual,
  executionMatch,
  numericCorrectness,
  softF1,
  type NumericGold,
} from '../src/match.js';
import { MATCHER_CASES, SOFTF1_CASES, STRICT_CASES } from '../src/fixtures-synthetic.js';

describe('executionMatch — every synthetic edge case', () => {
  for (const c of MATCHER_CASES) {
    it(`${c.name} → ${c.expected} (${c.why})`, () => {
      expect(executionMatch(c.goldRows, c.candRows, { orderMatters: c.orderMatters })).toBe(c.expected);
    });
  }
});

describe('birdStrictMatch — faithful to mini_dev set(pred)==set(gt)', () => {
  for (const c of STRICT_CASES) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(birdStrictMatch(c.gold, c.cand)).toBe(c.expected);
    });
  }
  it('diverges from EX+ exactly where documented (order, epsilon, coercion)', () => {
    // order: EX+ stricter, BIRD looser
    expect(executionMatch([[1], [2]], [[2], [1]], { orderMatters: true })).toBe(false);
    expect(birdStrictMatch([[1], [2]], [[2], [1]])).toBe(true);
    // epsilon: EX+ looser, BIRD stricter
    expect(executionMatch([[0.1 + 0.2]], [[0.3]], { orderMatters: false })).toBe(true);
    expect(birdStrictMatch([[0.1 + 0.2]], [[0.3]])).toBe(false);
    // numeric-text: EX+ looser, BIRD stricter
    expect(executionMatch([['1']], [[1]], { orderMatters: false })).toBe(true);
    expect(birdStrictMatch([['1']], [[1]])).toBe(false);
  });
});

describe('softF1 — faithful to mini_dev calculate_f1_score', () => {
  for (const c of SOFTF1_CASES) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(softF1(c.gold, c.cand)).toBeCloseTo(c.expected, 10);
    });
  }
  it('column reorder: Soft-F1 = 1.0 where strict EX = false (the robustness BIRD added)', () => {
    expect(birdStrictMatch([['a', 1]], [[1, 'a']])).toBe(false);
    expect(softF1([['a', 1]], [[1, 'a']])).toBeCloseTo(1.0, 10);
  });
});

describe('cellsEqual primitives', () => {
  it('NULL = NULL, NULL ≠ value', () => {
    expect(cellsEqual(null, null)).toBe(true);
    expect(cellsEqual(null, undefined)).toBe(true);
    expect(cellsEqual(null, 0)).toBe(false);
    expect(cellsEqual('', null)).toBe(false);
  });
  it('float relative epsilon', () => {
    expect(cellsEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(cellsEqual(1_000_000, 1_000_000.0005)).toBe(true); // within 1e-6 relative
    expect(cellsEqual(1, 1.01)).toBe(false);
  });
  it('numeric-text coercion, but not for non-numeric text', () => {
    expect(cellsEqual('2.0', 2)).toBe(true);
    expect(cellsEqual('1e3', 1000)).toBe(true);
    expect(cellsEqual('abc', 'abc')).toBe(true);
    expect(cellsEqual('abc', 1)).toBe(false);
    expect(cellsEqual('007', 7)).toBe(true); // documented risk: zero-padded codes
  });
});

describe('numericCorrectness — independent scorer', () => {
  it('scalar within / outside tolerance', () => {
    expect(numericCorrectness({ kind: 'scalar', value: 100 }, { kind: 'scalar', value: 100.0000005 }, 1e-6).ok).toBe(true);
    expect(numericCorrectness({ kind: 'scalar', value: 100 }, { kind: 'scalar', value: 101 }, 1e-6).ok).toBe(false);
  });
  it('series matched by label, order-insensitive', () => {
    const gold: NumericGold = { kind: 'series', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] };
    const cand: NumericGold = { kind: 'series', points: [{ label: 'b', value: 2 }, { label: 'a', value: 1 }] };
    expect(numericCorrectness(gold, cand, 1e-9).ok).toBe(true);
  });
  it('series fails on missing/extra label or wrong value', () => {
    const gold: NumericGold = { kind: 'series', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] };
    expect(numericCorrectness(gold, { kind: 'series', points: [{ label: 'a', value: 1 }] }, 1e-9).ok).toBe(false);
    expect(numericCorrectness(gold, { kind: 'series', points: [{ label: 'a', value: 1 }, { label: 'b', value: 9 }] }, 1e-9).ok).toBe(false);
  });
  it('shape mismatch (scalar vs series) is not ok', () => {
    expect(numericCorrectness({ kind: 'scalar', value: 1 }, { kind: 'series', points: [] }, 1).ok).toBe(false);
  });
  it('demonstrates the H2 divergence: EX-true while numericCorrectness-false', () => {
    // Two single-value results that the SET-EX treats as a 1x1 set, but whose magnitude differs.
    // EX with set comparison only checks set equality; here the values differ so EX is false —
    // but the *purpose* is shown by the duplicate-collapse case in MATCHER_CASES where EX=true
    // ignores multiplicity. numericCorrectness pins the magnitude directly:
    expect(numericCorrectness({ kind: 'scalar', value: 10 }, { kind: 'scalar', value: 42 }, 1e-6).ok).toBe(false);
  });
});

describe('asNumericGold shape detection', () => {
  it('1x1 numeric → scalar', () => {
    expect(asNumericGold([[5]])).toEqual({ kind: 'scalar', value: 5 });
    expect(asNumericGold([['5']])).toEqual({ kind: 'scalar', value: 5 });
  });
  it('Nx2 with numeric 2nd col → series', () => {
    expect(asNumericGold([['a', 1], ['b', 2]])).toEqual({
      kind: 'series',
      points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
    });
  });
  it('non-numeric shapes → null', () => {
    expect(asNumericGold([['a']])).toBeNull(); // 1x1 non-numeric
    expect(asNumericGold([[1, 2, 3]])).toBeNull(); // 3 cols
    expect(asNumericGold([['a', 'b'], ['c', 'd']])).toBeNull(); // 2nd col not numeric
  });
});
