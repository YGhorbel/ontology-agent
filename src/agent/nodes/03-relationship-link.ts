/**
 * Node 3 — Relationship Linker (deterministic, no LLM).
 *
 * Each foreign key becomes an `objectProperty` relationship between the two
 * classes. The predicate is composed mechanically from the FK column name
 * (strip a trailing `_id`, camelCase the rest). Cardinality defaults to
 * 'one-to-many' (the common FK case: one referenced row, many referencing rows);
 * LLM verification of relationship semantics is deferred to a later sprint.
 */
import type { CanonicalSchema } from '../../types/canonical-schema.js';
import { classIri, type Relationship } from '../../types/ontology.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

/** "customer_id" -> "customer", "order_id" -> "order", "parentCategory" -> "parentCategory". */
export function predicateFromColumn(column: string): string {
  const base = column.replace(/_id$/i, '');
  const parts = base.split(/[_\s]+/).filter(Boolean);
  if (parts.length === 0) return column;
  const head = (parts[0] ?? '').toLowerCase();
  const tail = parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return [head, ...tail].join('');
}

export function deriveRelationships(schema: CanonicalSchema): Relationship[] {
  return schema.foreignKeys.map((fk) => ({
    kind: 'objectProperty' as const,
    source: { class: classIri(fk.sourceTable) },
    target: { class: classIri(fk.targetTable) },
    predicate: predicateFromColumn(fk.sourceColumn),
    cardinality: 'one-to-many' as const,
    derivedFrom: { table: fk.sourceTable, foreignKey: fk.name },
  }));
}

export function createRelationshipLinkNode() {
  return async function relationshipLink(state: OntologyState): Promise<OntologyStateUpdate> {
    const schema = state.canonicalSchema;
    if (!schema) throw new Error('relationship-link: canonicalSchema is missing (node 1 did not run).');
    return { relationships: deriveRelationships(schema) };
  };
}
