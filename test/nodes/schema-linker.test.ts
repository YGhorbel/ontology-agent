import { describe, it, expect } from 'vitest';
import { linkQuestion } from '../../src/query/schema-linker.js';
import { parseEvidence } from '../../src/query/evidence.js';
import { QueryIntentSchema } from '../../src/types/query-intent.js';
import { goldenCases, f1Index, ecommerceIndex } from '../fixtures/golden-questions.js';

describe('linkQuestion — golden questions (f1 + ecommerce)', () => {
  for (const gc of goldenCases) {
    const label = gc.evidence ? `${gc.question} (+evidence)` : gc.question;
    it(`links: "${label}"`, () => {
      const hints = gc.evidence ? parseEvidence(gc.evidence, gc.index).hints : undefined;
      const intent = linkQuestion(gc.question, gc.index, hints ? { hints } : {});

      // Always a schema-valid intent that echoes the question.
      expect(() => QueryIntentSchema.parse(intent)).not.toThrow();
      expect(intent.question).toBe(gc.question);

      if (gc.tables) for (const t of gc.tables) expect(intent.tables).toContain(t);

      if (gc.projection) {
        const got = intent.projection.map((p) => `${p.table}.${p.column}`);
        for (const p of gc.projection) expect(got).toContain(p);
      }

      if (gc.measures) {
        const got = intent.measures.map((m) => `${m.table}.${m.column}`);
        if (gc.measures.length === 0) expect(intent.measures).toHaveLength(0);
        else for (const m of gc.measures) expect(got).toContain(m);
      }

      if (gc.filters) {
        const got = intent.filters.map((f) => `${f.table}.${f.column}=${f.value}`);
        for (const f of gc.filters) expect(got).toContain(f);
      }

      if (gc.groupDims) {
        const got = intent.groupDims.map((g) => `${g.table}.${g.column}`);
        for (const g of gc.groupDims) expect(got).toContain(g);
      }

      if (gc.orderBy) {
        const got = intent.orderBy.map((o) => `${o.table}.${o.column} ${o.dir}`);
        for (const o of gc.orderBy) expect(got).toContain(o);
      }
      if (gc.limit !== undefined) expect(intent.limit).toBe(gc.limit);

      if (gc.ambiguous) {
        const spans = intent.ambiguities.map((a) => a.span);
        for (const s of gc.ambiguous) expect(spans).toContain(s);
      }

      if (gc.unresolved) for (const u of gc.unresolved) expect(intent.unresolved).toContain(u);
      if (gc.unambiguous) expect(intent.ambiguities).toHaveLength(0);
    });
  }
});

describe('linkQuestion — channel behaviour', () => {
  it('flags a value-dictionary filter with matchedSample=true', () => {
    const intent = linkQuestion('revenue for active customers', ecommerceIndex);
    const filter = intent.filters.find((f) => f.column === 'status');
    expect(filter).toMatchObject({ table: 'customers', op: '=', value: 'active', matchedSample: true });
  });

  it('records ≥2 distinct candidate refs for an ambiguous span', () => {
    const intent = linkQuestion('show position', f1Index);
    const position = intent.ambiguities.find((a) => a.span === 'position');
    expect(position).toBeDefined();
    const refs = new Set(position!.candidates.map((c) => `${c.ref.table}.${c.ref.column ?? ''}`));
    expect(refs.size).toBeGreaterThanOrEqual(2);
  });

  it('resolves a metric synonym (altLabel) to its measure', () => {
    // "turnover" is an altLabel of the revenue metric.
    const intent = linkQuestion('total turnover', ecommerceIndex);
    expect(intent.measures.map((m) => `${m.table}.${m.column}`)).toContain('orders.total_amount');
  });

  it('tolerates a one-character typo in an entity name', () => {
    // "constructer" → constructor (single edit) should still find the table.
    const intent = linkQuestion('list constructers', f1Index);
    expect(intent.tables).toContain('constructors');
  });

  it('leaves an unrelated token unresolved rather than forcing a match', () => {
    const intent = linkQuestion('total points and gibberishtoken', f1Index);
    expect(intent.unresolved).toContain('gibberishtoken');
  });
});

describe('linkQuestion — skeleton (Sprint 3a)', () => {
  it('binds a bare integer to the entity named beside it (race number 20 → races.raceid)', () => {
    const intent = linkQuestion('race number 20', f1Index);
    const got = intent.filters.map((f) => `${f.table}.${f.column}=${f.value}`);
    expect(got).toContain('races.raceid=20');
  });

  it('does not match a bare number against value dictionaries', () => {
    // "20" must not become a filter on a position-like value dictionary out of nowhere.
    const intent = linkQuestion('20', f1Index);
    expect(intent.filters).toHaveLength(0);
  });

  it('projects a plain attribute column under a projection cue', () => {
    const intent = linkQuestion('list driver references', f1Index);
    expect(intent.projection.map((p) => `${p.table}.${p.column}`)).toContain('drivers.driverref');
  });

  it('derives ORDER BY + LIMIT from a superlative + number cue', () => {
    const intent = linkQuestion('top 5 drivers by points', f1Index);
    expect(intent.limit).toBe(5);
    expect(intent.orderBy.map((o) => `${o.table}.${o.column} ${o.dir}`)).toContain('results.points desc');
  });

  it('applies an evidence alias to a phrase the labels alone would miss', () => {
    const hints = parseEvidence('first qualifying period refers to q1', f1Index).hints;
    const intent = linkQuestion('drivers in the first period', f1Index, { hints });
    expect(intent.tables).toContain('qualifying');
    expect(intent.unresolved).not.toContain('period');
  });
});

describe('linkQuestion — assembler robustness (Sprint 3b)', () => {
  const fastest = 'what is the family name of the driver with the fastest lap speed';

  it('ranks by a metric instead of aggregating it (no measure, no group-by)', () => {
    const intent = linkQuestion(fastest, f1Index);
    expect(intent.measures).toHaveLength(0); // ranking context: not an aggregate
    expect(intent.groupDims).toHaveLength(0); // no GROUP BY without a measure
  });

  it('orders by the ranked metric descending and limits to one row', () => {
    const intent = linkQuestion(fastest, f1Index);
    expect(intent.orderBy.map((o) => `${o.table}.${o.column} ${o.dir}`)).toContain('results.fastestlapspeed desc');
    expect(intent.limit).toBe(1); // singular superlative subject ⇒ LIMIT 1
  });

  it('never projects a foreign-key column', () => {
    const fkCols = new Set(f1Index.joinEdges.map((e) => `${e.fromTable}.${e.fromColumn}`));
    const intent = linkQuestion(fastest, f1Index);
    for (const p of intent.projection) expect(fkCols.has(`${p.table}.${p.column}`)).toBe(false);
  });

  it('still aggregates (measure + group-by) when a grouping cue is present', () => {
    // Regression: ranking-context gating and "no group-by without a measure" must not
    // break the aggregate path — a measure keeps its column group dimension.
    const intent = linkQuestion('order count by currency', ecommerceIndex);
    expect(intent.measures.map((m) => `${m.table}.${m.column}`)).toContain('orders.id');
    expect(intent.groupDims.map((g) => `${g.table}.${g.column}`)).toContain('orders.currency');
  });
});
