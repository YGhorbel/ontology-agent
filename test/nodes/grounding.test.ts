import { describe, it, expect } from 'vitest';
import { selectRelevantSlice, buildFocusedGrounding, buildFullGrounding } from '../../src/query/grounding.js';
import { f1Index } from '../fixtures/golden-questions.js';

describe('buildFullGrounding (baseline)', () => {
  it('serializes all tables, sample values, metric formulas with polarity, and FK joins', () => {
    const g = buildFullGrounding(f1Index);
    expect(g).toContain('constructors');
    expect(g).toContain('British'); // a sample value
    expect(g).toMatch(/"points" = SUM\(results\.points\) \[higher is better\]/);
    expect(g).toContain('Foreign keys');
    expect(g).toContain('results.constructorid = constructors.constructorid');
  });
});

describe('selectRelevantSlice', () => {
  it('seeds from the linker and expands to join neighbours (recall-safe)', () => {
    const slice = selectRelevantSlice('the fastest lap by Schumacher', f1Index);
    expect(slice.tables).toContain('results'); // linked via the "fastest lap" metric
    expect(slice.tables).toContain('drivers'); // pulled in as a 1-hop join neighbour
    expect(slice.tables).not.toContain('seasons'); // not reachable in one hop → pruned
  });
});

describe('buildFocusedGrounding', () => {
  it('is smaller than the full dump and pre-resolves the join path', () => {
    const { grounding, stats, slice } = buildFocusedGrounding('total points for British constructors', f1Index);
    expect(stats.sliceTokens).toBeLessThan(stats.fullTokens); // real token reduction
    expect(stats.reductionPct).toBeGreaterThan(0);
    expect(grounding).toContain('Foreign keys'); // FKs as a reference, not a mandated join chain
    expect(grounding).toContain('results.constructorid = constructors.constructorid');
    expect(slice.tables).toContain('results');
    expect(slice.tables).toContain('constructors');
    expect(slice.tables).not.toContain('seasons'); // out-of-slice table excluded
  });

  it('surfaces unresolved terms as resolve-these hints', () => {
    const { grounding } = buildFocusedGrounding('total points and gibberishtoken', f1Index);
    expect(grounding).toContain('Unresolved terms');
    expect(grounding).toContain('gibberishtoken');
  });
});
