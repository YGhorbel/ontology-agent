import { describe, it, expect } from 'vitest';
import {
  resolveIntent,
  generateIntentWithLlm,
  groundLlmIntent,
  pickHint,
  LlmIntentSchema,
} from '../../src/query/llm-intent.js';
import { QueryIntentSchema } from '../../src/types/query-intent.js';
import { makeFakeLlm } from '../../src/llm/structured-llm.js';
import { f1Index } from '../fixtures/golden-questions.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { buildOntologyIndex } from '../../src/query/ontology-index.js';
import type { ConceptCandidate } from '../../src/types/ontology.js';
import type { ColumnFact } from '../../src/types/column-fact.js';

/** Build a valid LlmIntent from a partial (zod fills the array/limit defaults). */
const llmIntent = (partial: Record<string, unknown>) => LlmIntentSchema.parse(partial);

/** A minimal index where the value "Paris" lives in two columns on different tables. */
function sharedValueIndex() {
  const cls = (table: string, prefLabel: string): ConceptCandidate => ({ source: { table }, ontologyKind: 'Class', prefLabel, altLabel: [], rdfsLabel: prefLabel, rdfsComment: prefLabel });
  const prop = (table: string, column: string, prefLabel: string): ConceptCandidate => ({ source: { table, column }, ontologyKind: 'DatatypeProperty', prefLabel, altLabel: [], rdfsLabel: prefLabel, rdfsComment: prefLabel });
  const fact = (table: string, column: string, sampleValues: string[]): ColumnFact => ({ table, column, dataType: 'text', isNumericText: false, isUnique: false, isPrimaryKey: false, distinctCount: null, nullable: false, sampleValues });
  const concepts = [cls('venues', 'Venue'), prop('venues', 'city', 'City'), cls('teams', 'Team'), prop('teams', 'town', 'Town')];
  const facts = [fact('venues', 'city', ['Paris', 'London']), fact('teams', 'town', ['Paris', 'Lyon'])];
  return buildOntologyIndex(assembleOntology(concepts, [], [], facts));
}

describe('generateIntentWithLlm', () => {
  it('feeds the model the focused grounding and returns a schema-valid QueryIntent + stats', async () => {
    let seenUser = '';
    const llm = makeFakeLlm([
      {
        when: (user) => {
          seenUser = user;
          return user.includes('Tables:');
        },
        respond: () => ({
          tables: ['drivers'],
          projection: [{ table: 'drivers', column: 'surname' }],
          rationale: 'family name',
        }),
      },
    ]);
    const out = await generateIntentWithLlm('the family name of a driver', f1Index, llm);
    expect(() => QueryIntentSchema.parse(out.intent)).not.toThrow();
    expect(out.intent.projection.map((p) => `${p.table}.${p.column}`)).toContain('drivers.surname');
    expect(seenUser).toContain('Tables:'); // grounding actually reached the model
    expect(out.stats.sliceTokens).toBeLessThanOrEqual(out.stats.fullTokens);
  });
});

describe('groundLlmIntent (grounding-as-validation)', () => {
  it('drops hallucinated tables/columns and warns', () => {
    const g = groundLlmIntent(
      'q',
      llmIntent({
        tables: ['drivers', 'nope'],
        projection: [
          { table: 'drivers', column: 'surname' },
          { table: 'drivers', column: 'ghostcol' },
        ],
      }),
      f1Index,
    );
    expect(g.intent.tables).toContain('drivers');
    expect(g.intent.tables).not.toContain('nope');
    const projCols = g.intent.projection.map((p) => p.column);
    expect(projCols).toContain('surname');
    expect(projCols).not.toContain('ghostcol');
    const warns = g.warnings.join(' ');
    expect(warns).toContain('nope');
    expect(warns).toContain('ghostcol');
  });

  it('sets matchedSample from the column value dictionary', () => {
    const hit = groundLlmIntent(
      'q',
      llmIntent({ tables: ['constructors'], filters: [{ table: 'constructors', column: 'nationality', op: '=', value: 'British' }] }),
      f1Index,
    );
    expect(hit.intent.filters[0]?.matchedSample).toBe(true);

    const miss = groundLlmIntent(
      'q',
      llmIntent({ tables: ['constructors'], filters: [{ table: 'constructors', column: 'nationality', op: '=', value: 'Atlantean' }] }),
      f1Index,
    );
    expect(miss.intent.filters[0]?.matchedSample).toBe(false);
  });

  it('escalates an LLM-flagged ambiguity to a clarification', () => {
    const g = groundLlmIntent(
      'show position',
      llmIntent({
        tables: ['results'],
        ambiguities: [
          {
            span: 'position',
            candidates: [
              { table: 'results', column: 'position' },
              { table: 'driverstandings', column: 'position' },
            ],
            clarification: 'Which position did you mean — race result or standings?',
          },
        ],
      }),
      f1Index,
    );
    expect(g.clarification?.span).toBe('position');
    expect(g.clarification?.options).toHaveLength(2);
    expect(g.intent.ambiguities.map((a) => a.span)).toContain('position');
  });
});

describe('groundLlmIntent — slot hygiene & ambiguity (review fixes)', () => {
  it('M1: cleans projection — drops measure-duplicate, primary-key, and foreign-key columns', () => {
    const g = groundLlmIntent(
      'q',
      llmIntent({
        tables: ['results', 'constructors', 'drivers'],
        measures: [{ table: 'results', column: 'points', capability: 'points' }],
        projection: [
          { table: 'results', column: 'points' }, // duplicate of the measure → dropped
          { table: 'constructors', column: 'constructorid' }, // primary key → dropped
          { table: 'results', column: 'constructorid' }, // foreign key → dropped
          { table: 'drivers', column: 'surname' }, // plain attribute → kept
        ],
      }),
      f1Index,
    );
    expect(g.intent.projection.map((p) => `${p.table}.${p.column}`)).toEqual(['drivers.surname']);
  });

  it('M2: drops group dimensions when there is no measure', () => {
    const g = groundLlmIntent('q', llmIntent({ tables: ['constructors'], groupDims: [{ table: 'constructors', column: 'name' }] }), f1Index);
    expect(g.intent.groupDims).toHaveLength(0);
  });

  it('records a value-dictionary ambiguity (value in >1 column) WITHOUT escalating to a clarification', () => {
    const idx = sharedValueIndex();
    const g = groundLlmIntent('q', llmIntent({ tables: ['venues'], filters: [{ table: 'venues', column: 'city', op: '=', value: 'Paris' }] }), idx);
    expect(g.intent.ambiguities.map((a) => a.span)).toContain('Paris'); // surfaced for visibility
    expect(g.clarification).toBeUndefined(); // but the LLM already chose → no blocking prompt
  });

  it('does not raise a clarification when a grounded ambiguity collapses to one valid candidate', () => {
    const g = groundLlmIntent(
      'show position',
      llmIntent({
        tables: ['results'],
        ambiguities: [
          {
            span: 'position',
            candidates: [
              { table: 'results', column: 'position' },
              { table: 'nope', column: 'ghost' }, // hallucinated → filtered out
            ],
            clarification: '?',
          },
        ],
      }),
      f1Index,
    );
    expect(g.clarification).toBeUndefined();
    expect(g.intent.ambiguities.map((a) => a.span)).not.toContain('position');
  });
});

describe('resolveIntent (LLM intent is authoritative)', () => {
  it('returns the deterministic intent when no LLM is supplied', async () => {
    const r = await resolveIntent('total points for British constructors', f1Index, {});
    expect(r.source).toBe('deterministic');
    expect(r.intent.measures.map((m) => `${m.table}.${m.column}`)).toContain('results.points');
  });

  it('uses the LLM intent directly — the deterministic intent is NOT merged in', async () => {
    // The deterministic linker would find the metric (results.points); the LLM here returns
    // ONLY an entity filter. The result must be the LLM's intent, with no deterministic measure.
    const llm = makeFakeLlm([
      {
        when: (user) => user.includes('Tables:'),
        respond: () => ({
          tables: ['drivers'],
          filters: [{ table: 'drivers', column: 'surname', op: '=', value: 'Hamilton' }],
          rationale: 'driver filter',
        }),
      },
    ]);
    const r = await resolveIntent('total points for Hamilton', f1Index, { llm });
    expect(r.source).toBe('llm');
    expect(r.intent.filters.map((f) => `${f.table}.${f.column}=${f.value}`)).toContain('drivers.surname=Hamilton');
    expect(r.intent.measures).toHaveLength(0); // deterministic results.points NOT fused in
    expect(r.intent.tables).toEqual(['drivers']);
  });

  it('falls back to the deterministic intent when the LLM call fails', async () => {
    const llm = makeFakeLlm([]); // no canned response → generate throws
    const r = await resolveIntent('total points for British constructors', f1Index, { llm });
    expect(r.source).toBe('deterministic');
    expect(r.error).toBeDefined();
    expect(r.intent.measures.map((m) => `${m.table}.${m.column}`)).toContain('results.points');
  });

  it('surfaces a clarification, then a pick re-resolves it deterministically', async () => {
    const llm = makeFakeLlm([
      {
        when: (user) => user.includes('Tables:'),
        respond: () => ({
          tables: ['results'],
          ambiguities: [
            {
              span: 'position',
              candidates: [
                { table: 'results', column: 'position' },
                { table: 'driverstandings', column: 'position' },
              ],
              clarification: 'Which position?',
            },
          ],
        }),
      },
    ]);
    const r = await resolveIntent('show position', f1Index, { llm });
    expect(r.source).toBe('llm');
    expect(r.clarification?.span).toBe('position');

    // The user picks "results.position"; the alias hint binds the span and re-links.
    const hints = pickHint('position', { table: 'results', column: 'position' });
    const r2 = await resolveIntent('show position', f1Index, { hints });
    expect(r2.source).toBe('deterministic');
    expect(r2.intent.tables).toContain('results');
    expect(r2.intent.ambiguities.map((a) => a.span)).not.toContain('position');
  });
});
