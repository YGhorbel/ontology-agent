import { describe, it, expect } from 'vitest';
import { selectRelevantSlice, buildFocusedGrounding, buildFullGrounding } from '../../src/query/grounding.js';
import { f1Index } from '../fixtures/golden-questions.js';
import type { OntologyIndex, ColumnInfo, CapabilityInfo } from '../../src/query/ontology-index.js';

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

describe('grounding annotations (ontology-signal wiring)', () => {
  const col = (o: Partial<ColumnInfo> & { column: string }): ColumnInfo => ({ prefLabel: o.column, altLabel: [], comment: '', ...o });
  const index: OntologyIndex = {
    classes: new Map(),
    columnsByTable: new Map<string, ColumnInfo[]>([
      ['driverstandings', [col({ column: 'points', temporality: 'cumulative-snapshot', temporalityEvidence: { partitionColumns: ['driverid', 'year'], orderColumn: 'round', ratio: 1 } })]],
      ['drivers', [col({ column: 'driverid', isPrimaryKey: true })]],
    ]),
    capabilities: [
      { kind: 'metric', scopeTable: 'driverstandings', scopeColumn: 'points', prefLabel: 'championship points', altLabel: [], formulaHint: 'MAX(driverstandings.points)', provenance: 'llm' } as CapabilityInfo,
    ],
    joinEdges: [
      { fromTable: 'driverstandings', fromColumn: 'driverid', toTable: 'drivers', toColumn: 'driverid', extraColumns: [], cardinality: 'many-to-one', confidence: 1, provenance: 'declared' },
    ],
  };

  it('marks a cumulative column, the metric provenance tier, and a fan-out legend', () => {
    const g = buildFullGrounding(index);
    expect(g).toMatch(/points.*~cumulative \(last value per driverid\+year by round\)/);
    expect(g).toContain('[llm-inferred — verify]');
    expect(g).toContain('MULTIPLIES rows'); // cardinality legend in the FK block
  });
});
