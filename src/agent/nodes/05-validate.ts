/**
 * Node 5 — Validator (deterministic, no LLM).
 *
 * Assembles the JSON-LD ontology from the candidates/relationships/capabilities,
 * then runs four structural rules. Errors are *collected*, not thrown, so the
 * graph can decide retry-vs-persist. This node is pure: it never increments the
 * retry counter (node 2 owns that) and never touches the database (the CLI persists).
 */
import { assembleOntology } from '../assemble.js';
import type { CanonicalSchema } from '../../types/canonical-schema.js';
import { type OntologyJsonLd, type ValidationError } from '../../types/ontology.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

const FORMULA_TOKEN = /\b([a-zA-Z_][A-Za-z0-9_]*)\.([a-zA-Z_][A-Za-z0-9_]*)\b/g;

/** Pure validator, exported for direct unit testing. */
export function validateOntology(ontology: OntologyJsonLd, schema: CanonicalSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  const graph = ontology['@graph'];

  const classIds = new Set(graph.filter((n) => n['@type'] === 'owl:Class').map((n) => n['@id']));

  // Rule 1: every objectProperty has a domain & range that exist as classes.
  for (const n of graph) {
    if (n['@type'] !== 'owl:ObjectProperty') continue;
    const domain = n['rdfs:domain']['@id'];
    const range = n['rdfs:range']['@id'];
    if (!classIds.has(domain)) {
      errors.push({
        rule: 'object-property-domain-range',
        subject: n['@id'],
        message: `domain ${domain} is not a defined class`,
      });
    }
    if (!classIds.has(range)) {
      errors.push({
        rule: 'object-property-domain-range',
        subject: n['@id'],
        message: `range ${range} is not a defined class`,
      });
    }
  }

  // Rule 2: every metric formula references columns that exist in the schema.
  const columnRefs = new Set<string>();
  for (const t of schema.tables) {
    for (const c of t.columns) columnRefs.add(`${t.name}.${c.name}`.toLowerCase());
  }
  for (const n of graph) {
    if (n['@type'] !== 'qsl:Capability' || n['qsl:kind'] !== 'metric') continue;
    const formula = n['qsl:formulaHint'];
    if (!formula) continue;
    for (const m of formula.matchAll(FORMULA_TOKEN)) {
      const ref = `${m[1]}.${m[2]}`.toLowerCase();
      if (!columnRefs.has(ref)) {
        errors.push({
          rule: 'metric-formula-columns',
          subject: n['@id'],
          message: `formula references unknown column ${m[1]}.${m[2]}`,
        });
      }
    }
  }

  // Rule 3: SKOS prefLabel unique within scope (class bucket / per-domain property bucket / capability bucket).
  const seen = new Map<string, Set<string>>();
  const checkUnique = (bucket: string, label: string, subject: string): void => {
    const set = seen.get(bucket) ?? new Set<string>();
    if (set.has(label.toLowerCase())) {
      errors.push({
        rule: 'skos-preflabel-unique',
        subject,
        message: `duplicate prefLabel "${label}" within scope ${bucket}`,
      });
    }
    set.add(label.toLowerCase());
    seen.set(bucket, set);
  };
  for (const n of graph) {
    if (n['@type'] === 'owl:Class') checkUnique('class', n['skos:prefLabel'], n['@id']);
    else if (n['@type'] === 'owl:DatatypeProperty')
      checkUnique(`prop:${n['rdfs:domain']['@id']}`, n['skos:prefLabel'], n['@id']);
    else if (n['@type'] === 'qsl:Capability' && n['skos:prefLabel'])
      checkUnique('capability', n['skos:prefLabel'], n['@id']);
  }

  // Rule 4: no orphan classes (each class is referenced by >=1 property/relationship/capability).
  const referenced = new Set<string>();
  for (const n of graph) {
    if (n['@type'] === 'owl:DatatypeProperty') referenced.add(n['rdfs:domain']['@id']);
    else if (n['@type'] === 'owl:ObjectProperty') {
      referenced.add(n['rdfs:domain']['@id']);
      referenced.add(n['rdfs:range']['@id']);
    } else if (n['@type'] === 'qsl:Capability') referenced.add(n['qsl:scopeClass']);
  }
  for (const id of classIds) {
    if (!referenced.has(id)) {
      errors.push({ rule: 'orphan-class', subject: id, message: `class ${id} has no properties or relationships` });
    }
  }

  return errors;
}

export function createValidateNode() {
  return async function validate(state: OntologyState): Promise<OntologyStateUpdate> {
    const { canonicalSchema, conceptCandidates, relationships, capabilities } = state;
    if (!canonicalSchema || !conceptCandidates || !relationships || !capabilities) {
      throw new Error('validate: required prior state is missing.');
    }
    const ontology = assembleOntology(conceptCandidates, relationships, capabilities);
    const validationErrors = validateOntology(ontology, canonicalSchema);
    return { ontology, validationErrors };
  };
}
