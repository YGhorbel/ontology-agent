import { describe, it, expect } from 'vitest';
import { discoverCompositeForeignKeys, buildCompositeContainmentQuery } from '../../src/profiling/composite-fk.js';
import { compositeRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { buildOntologyIndex } from '../../src/query/ontology-index.js';
import { type ConceptCandidate } from '../../src/types/ontology.js';
import type { CanonicalSchema, Table } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { ForeignKeyCandidate, CompositeForeignKeyCandidate } from '../../src/types/foreign-key-candidate.js';
import type { KeyCandidate } from '../../src/types/key-candidate.js';
import type { Queryable } from '../../src/storage/pg.js';

const col = (name: string): Table['columns'][number] => ({ name, type: 'bigint', nullable: false, default: null, comment: null, position: 1 });
const fk = (s: string, sc: string, t: string) => ({ name: `${s}_${sc}_fkey`, sourceTable: s, sourceColumn: sc, targetTable: t, targetColumn: sc, onDelete: 'NO ACTION' });

const schema: CanonicalSchema = {
  datasourceId: 'f1',
  tables: [
    { name: 'races', comment: null, columns: [col('raceid')], sampleRows: [], numericStats: [] },
    { name: 'drivers', comment: null, columns: [col('driverid')], sampleRows: [], numericStats: [] },
    { name: 'laptimes', comment: null, columns: [col('raceid'), col('driverid'), col('lap')], sampleRows: [], numericStats: [] },
    { name: 'results', comment: null, columns: [col('resultid'), col('raceid'), col('driverid')], sampleRows: [], numericStats: [] },
  ],
  foreignKeys: [fk('laptimes', 'raceid', 'races'), fk('laptimes', 'driverid', 'drivers'), fk('results', 'raceid', 'races'), fk('results', 'driverid', 'drivers')],
};

const profile = (table: string, column: string, numRows: number): ColumnProfile => ({
  table, column, dataType: 'bigint', numRows, nullCount: 0, nullRatio: 0, distinctCount: numRows, uniquenessRatio: 1, min: '1', max: '9',
});

const key = (table: string, columns: string[], opts: Partial<KeyCandidate> = {}): KeyCandidate => ({
  table, columns, numRows: 23179, distinctCount: opts.distinctCount ?? null, unique: true, certain: true, minimal: true, declared: null,
  method: columns.length === 1 ? 'single-column' : 'composite-probe', ...opts,
});

/** (raceid,driverid) is the real composite key on results; single uniques are the surrogate PK only. */
const f1Keys: KeyCandidate[] = [key('results', ['raceid', 'driverid']), key('results', ['resultid'])];

/** Mock: SET LOCAL → noop; the 2-column containment scan → laptimes pairs ⊆ results pairs. */
const containmentOk: Queryable = {
  async query(text) {
    if (text.startsWith('SET LOCAL')) return { rows: [] };
    if (text.includes('LEFT JOIN')) return { rows: [{ src_distinct: 7593, missing: 7 }] };
    return { rows: [] };
  },
};

describe('discoverCompositeForeignKeys (Fix 7) — candidate generation', () => {
  const profiles = [profile('laptimes', 'lap', 400524), profile('results', 'resultid', 23179)];

  it('POSITIVE: emits laptimes(raceid,driverid) → results(raceid,driverid)', async () => {
    const out = await discoverCompositeForeignKeys(containmentOk, schema, [], f1Keys, profiles);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceTable).toBe('laptimes');
    expect(out[0]!.targetTable).toBe('results');
    expect(out[0]!.sourceColumns.slice().sort()).toEqual(['driverid', 'raceid']);
    expect(out[0]!.targetColumns.slice().sort()).toEqual(['driverid', 'raceid']);
  });

  it('R1: never forms a same-column pair (circuitid,circuitid)', async () => {
    // `bad` has ONE column `circuitid` that is (spuriously) a trusted FK to BOTH parents; the
    // only candidate pair would double circuitid. Must not be generated.
    const s: CanonicalSchema = {
      datasourceId: 'f1',
      tables: [
        { name: 'p1', comment: null, columns: [col('k')], sampleRows: [], numericStats: [] },
        { name: 'p2', comment: null, columns: [col('k')], sampleRows: [], numericStats: [] },
        { name: 'bad', comment: null, columns: [col('circuitid')], sampleRows: [], numericStats: [] },
        { name: 'sib', comment: null, columns: [col('circuitid')], sampleRows: [], numericStats: [] },
      ],
      foreignKeys: [
        { name: 'b1', sourceTable: 'bad', sourceColumn: 'circuitid', targetTable: 'p1', targetColumn: 'k', onDelete: 'NO ACTION' },
        { name: 'b2', sourceTable: 'bad', sourceColumn: 'circuitid', targetTable: 'p2', targetColumn: 'k', onDelete: 'NO ACTION' },
        { name: 's1', sourceTable: 'sib', sourceColumn: 'circuitid', targetTable: 'p1', targetColumn: 'k', onDelete: 'NO ACTION' },
        { name: 's2', sourceTable: 'sib', sourceColumn: 'circuitid', targetTable: 'p2', targetColumn: 'k', onDelete: 'NO ACTION' },
      ],
    };
    const keys = [key('sib', ['circuitid', 'circuitid'])]; // even if offered, degenerate
    const out = await discoverCompositeForeignKeys(containmentOk, s, [], keys, [profile('bad', 'circuitid', 10), profile('sib', 'circuitid', 10)]);
    expect(out).toHaveLength(0);
  });

  it('R2: a low-confidence (≤0.05) discovered FK does not satisfy the per-column prerequisite', async () => {
    // raceid is a real shared parent; lap→results is only a 0.05 coincidental IND → not trusted,
    // so there is just ONE trusted correspondence and no composite forms via `lap`.
    const noise: ForeignKeyCandidate = {
      kind: 'foreign-key', sourceTable: 'laptimes', sourceColumn: 'lap', targetTable: 'results', targetColumn: 'resultid',
      junctionTable: null, cardinality: 'one-to-many', verified: true, containmentRatio: 0.9, score: 0.05, declared: false, evidence: 'ind',
      signals: { nameSimilarity: 0, surrogate: false, rhsReferences: 1 },
    };
    const out = await discoverCompositeForeignKeys(containmentOk, schema, [noise], f1Keys, profiles);
    expect(out.find((c) => c.sourceColumns.includes('lap'))).toBeUndefined();
  });

  it('R3: skips when the target pair is not a discovered/declared 2-column unique key', async () => {
    const out = await discoverCompositeForeignKeys(containmentOk, schema, [], [key('results', ['resultid'])], profiles);
    expect(out).toHaveLength(0);
  });

  it('R4: skips when a single component already keys the target (unary-redundant)', async () => {
    // raceid declared individually unique on results → a unary FK already determines the row.
    const keys = [key('results', ['raceid', 'driverid']), key('results', ['raceid'])];
    const out = await discoverCompositeForeignKeys(containmentOk, schema, [], keys, profiles);
    expect(out).toHaveLength(0);
  });

  it('R5: skips a table above ONTOLOGY_COMPOSITE_MAX_ROWS', async () => {
    const big = [profile('laptimes', 'lap', 9_000_000), profile('results', 'resultid', 23179)];
    const out = await discoverCompositeForeignKeys(containmentOk, schema, [], f1Keys, big);
    expect(out).toHaveLength(0);
  });

  it('R5: skips when the 2-column IND containment is below the threshold', async () => {
    const lowContainment: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (text.includes('LEFT JOIN')) return { rows: [{ src_distinct: 1000, missing: 600 }] }; // 0.4
        return { rows: [] };
      },
    };
    const out = await discoverCompositeForeignKeys(lowContainment, schema, [], f1Keys, profiles);
    expect(out).toHaveLength(0);
  });

  it('builds a 2-column containment query', () => {
    const sql = buildCompositeContainmentQuery('laptimes', ['raceid', 'driverid'], 'results', ['raceid', 'driverid']);
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('t.k1 = s.k1 AND t.k2 = s.k2');
  });
});

describe('compositeRelationships + ontology index (Fix 7)', () => {
  const composite: CompositeForeignKeyCandidate = {
    sourceTable: 'laptimes', sourceColumns: ['raceid', 'driverid'], targetTable: 'results', targetColumns: ['raceid', 'driverid'],
    containmentRatio: 0.999, targetUniqueness: 1, score: 0.999,
  };

  it('maps to a many-to-one object property with compositeJoin', () => {
    const [r] = compositeRelationships([composite]);
    expect(r?.cardinality).toBe('many-to-one');
    expect(r?.compositeJoin).toEqual({ fromColumns: ['raceid', 'driverid'], toColumns: ['raceid', 'driverid'] });
    expect(r?.derivedFrom.foreignKey).toBe('comp__results');
  });

  it('becomes a multi-column join edge with extraColumns in the index', () => {
    const concepts: ConceptCandidate[] = [
      { source: { table: 'laptimes' }, ontologyKind: 'Class', prefLabel: 'Lap', altLabel: [], rdfsLabel: 'Lap', rdfsComment: 'l' },
      { source: { table: 'results' }, ontologyKind: 'Class', prefLabel: 'Result', altLabel: [], rdfsLabel: 'Result', rdfsComment: 'r' },
    ];
    const ontology = assembleOntology(concepts, compositeRelationships([composite]), []);
    const edges = buildOntologyIndex(ontology).joinEdges;
    const comp = edges.find((e) => e.fromTable === 'laptimes' && e.toTable === 'results');
    expect(comp).toBeTruthy();
    expect(comp!.extraColumns).toHaveLength(1); // raceid as primary + driverid as extra
    const allPairs = [{ from: comp!.fromColumn, to: comp!.toColumn }, ...comp!.extraColumns];
    expect(allPairs.map((p) => p.from).sort()).toEqual(['driverid', 'raceid']);
  });
});
