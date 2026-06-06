/**
 * Node 3 — Relationship Linker (deterministic, no LLM).
 *
 * Merges two sources of foreign keys into `objectProperty` relationships:
 *   1. declared catalog FK constraints (`schema.foreignKeys`), authoritative; and
 *   2. profiling-discovered FK candidates (`state.foreignKeyCandidates`), the
 *      undeclared FKs / self-references / N:M junctions recovered by the
 *      profiling pipeline, kept only above an FK-likelihood threshold.
 *
 * Each relationship carries `provenance` (declared|discovered), `confidence`, and
 * the profiling-inferred `cardinality` (replacing the old hardcoded one-to-many).
 * The predicate is composed mechanically from the FK column name (strip a trailing
 * `_id`, camelCase the rest). N:M junctions become a single direct A→B property
 * (the junction table is recorded, not reified into a class).
 */
import type { CanonicalSchema } from '../../types/canonical-schema.js';
import type { ForeignKeyCandidate } from '../../types/foreign-key-candidate.js';
import { classIri, type Relationship } from '../../types/ontology.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

/**
 * FK-likelihood floor for promoting a *discovered* FK. Default 0 = keep every
 * verified inclusion dependency (maximum recall); each relationship still carries
 * its `confidence`, so consumers can filter downstream without regenerating.
 * Raise via ONTOLOGY_FK_MIN_SCORE (e.g. 0.5 drops surrogate-key coincidences).
 */
const minScoreFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_FK_MIN_SCORE);
  return Number.isFinite(raw) ? raw : 0;
};

const fkKey = (s: string, sc: string, t: string, tc: string): string => `${s} ${sc} ${t} ${tc}`;

/** "customer_id" -> "customer", "order_id" -> "order", "parentCategory" -> "parentCategory". */
export function predicateFromColumn(column: string): string {
  const base = column.replace(/_id$/i, '');
  const parts = base.split(/[_\s]+/).filter(Boolean);
  if (parts.length === 0) return column;
  const head = (parts[0] ?? '').toLowerCase();
  const tail = parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return [head, ...tail].join('');
}

/**
 * Merge declared FK constraints with profiling-discovered FK candidates.
 *
 * Order of precedence: declared FKs first (authoritative, confidence 1), their
 * cardinality refined from the matching candidate when one exists; then
 * discovered unary FKs / self-references above `minScore` that aren't already
 * declared; then N:M junctions above `minScore` as direct A→B properties.
 */
export function mergeRelationships(
  schema: CanonicalSchema,
  candidates: ForeignKeyCandidate[],
  minScore: number = minScoreFromEnv(),
): Relationship[] {
  // Index unary candidates by their 4-tuple so a declared FK can borrow the
  // profiling-inferred cardinality (1:1 vs 1:N) instead of the hardcoded default.
  const byTuple = new Map<string, ForeignKeyCandidate>();
  for (const c of candidates) {
    if (c.sourceColumn && c.targetColumn) {
      byTuple.set(fkKey(c.sourceTable, c.sourceColumn, c.targetTable, c.targetColumn), c);
    }
  }

  const seen = new Set<string>();
  const relationships: Relationship[] = [];

  // 1. Declared FKs — authoritative.
  for (const fk of schema.foreignKeys) {
    const k = fkKey(fk.sourceTable, fk.sourceColumn, fk.targetTable, fk.targetColumn);
    seen.add(k);
    relationships.push({
      kind: 'objectProperty',
      source: { class: classIri(fk.sourceTable) },
      target: { class: classIri(fk.targetTable) },
      predicate: predicateFromColumn(fk.sourceColumn),
      cardinality: byTuple.get(k)?.cardinality ?? 'one-to-many',
      provenance: 'declared',
      confidence: 1,
      junctionTable: null,
      derivedFrom: { table: fk.sourceTable, foreignKey: fk.name },
    });
  }

  // 2. Discovered unary FKs + self-references above the score threshold.
  for (const c of candidates) {
    if (c.declared || c.kind === 'many-to-many') continue;
    if (c.score < minScore || !c.sourceColumn || !c.targetColumn) continue;
    const k = fkKey(c.sourceTable, c.sourceColumn, c.targetTable, c.targetColumn);
    if (seen.has(k)) continue;
    seen.add(k);
    relationships.push({
      kind: 'objectProperty',
      source: { class: classIri(c.sourceTable) },
      target: { class: classIri(c.targetTable) },
      predicate: predicateFromColumn(c.sourceColumn),
      cardinality: c.cardinality,
      provenance: 'discovered',
      confidence: c.score,
      junctionTable: null,
      derivedFrom: { table: c.sourceTable, foreignKey: `disc__${c.sourceColumn}__${c.targetTable}` },
    });
  }

  // 3. N:M junctions above the threshold — one direct A→B object property.
  for (const c of candidates) {
    if (c.kind !== 'many-to-many' || c.score < minScore || !c.junctionTable) continue;
    relationships.push({
      kind: 'objectProperty',
      source: { class: classIri(c.sourceTable) },
      target: { class: classIri(c.targetTable) },
      predicate: predicateFromColumn(c.targetTable),
      cardinality: 'many-to-many',
      provenance: c.declared ? 'declared' : 'discovered',
      confidence: c.score,
      junctionTable: c.junctionTable,
      derivedFrom: { table: c.junctionTable, foreignKey: `nm__${c.targetTable}` },
    });
  }

  return relationships;
}

/** Declared-only relationships (no profiling). Retained for direct/unit use. */
export function deriveRelationships(schema: CanonicalSchema): Relationship[] {
  return mergeRelationships(schema, []);
}

export function createRelationshipLinkNode() {
  return async function relationshipLink(state: OntologyState): Promise<OntologyStateUpdate> {
    const schema = state.canonicalSchema;
    if (!schema) throw new Error('relationship-link: canonicalSchema is missing (node 1 did not run).');
    return { relationships: mergeRelationships(schema, state.foreignKeyCandidates ?? []) };
  };
}
