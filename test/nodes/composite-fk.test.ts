import { describe, it, expect } from 'vitest';
import { discoverCompositeForeignKeys, buildCompositeContainmentQuery } from '../../src/profiling/composite-fk.js';
import { compositeRelationships } from '../../src/agent/nodes/03-relationship-link.js';
import { assembleOntology } from '../../src/agent/assemble.js';
import { buildOntologyIndex } from '../../src/query/ontology-index.js';
import { classIri, type ConceptCandidate } from '../../src/types/ontology.js';
import type { CanonicalSchema, Table } from '../../src/types/canonical-schema.js';
import type { ColumnProfile } from '../../src/types/column-profile.js';
import type { CompositeForeignKeyCandidate } from '../../src/types/foreign-key-candidate.js';
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

describe('discoverCompositeForeignKeys (Fix 7)', () => {
  it('finds laptimes(raceid,driverid) → results(raceid,driverid)', async () => {
    const profiles = [profile('laptimes', 'lap', 400524), profile('results', 'resultid', 23179)];
    const q: Queryable = {
      async query(text) {
        if (text.startsWith('SET LOCAL')) return { rows: [] };
        if (text.includes('LEFT JOIN')) return { rows: [{ src_distinct: 7593, missing: 7 }] }; // laptimes ⊆ results
        if (text.includes('FROM "laptimes"')) return { rows: [{ n: 400524, d: 7593 }] }; // non-unique pair
        if (text.includes('FROM "results"')) return { rows: [{ n: 23179, d: 23090 }] }; // ~unique pair (0.996)
        return { rows: [{ n: 0, d: 0 }] };
      },
    };
    const out = await discoverCompositeForeignKeys(q, schema, [], profiles);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceTable).toBe('laptimes');
    expect(out[0]!.targetTable).toBe('results');
    expect(out[0]!.sourceColumns.sort()).toEqual(['driverid', 'raceid']);
  });

  it('skips a table above ONTOLOGY_COMPOSITE_MAX_ROWS', async () => {
    const profiles = [profile('laptimes', 'lap', 9_000_000), profile('results', 'resultid', 23179)];
    const q: Queryable = { async query() { return { rows: [] }; } };
    const out = await discoverCompositeForeignKeys(q, schema, [], profiles);
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
    containmentRatio: 0.999, targetUniqueness: 0.996, score: 0.996,
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
