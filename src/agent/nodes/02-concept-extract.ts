/**
 * Node 2 — Concept Extractor (LLM, batched one call per table).
 *
 * For each table the model proposes an OWL class (label, synonyms, description)
 * and a property per column (label, synonyms, description). Output is mapped to
 * internal `ConceptCandidate`s. Any real column the model omits gets a synthesized
 * property so every column is always represented (keeps the validator happy and the
 * fragment count complete). On a retry pass, prior validation errors are fed into
 * the prompt so the model can self-correct.
 */
import { z } from 'zod';
import type { StructuredLlm } from '../../llm/structured-llm.js';
import { CONCEPT_EXTRACT_SYSTEM, buildConceptExtractPrompt } from '../../prompts/concept-extract.js';
import type { CanonicalSchema, Table } from '../../types/canonical-schema.js';
import { type ConceptCandidate } from '../../types/ontology.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

/** LLM-facing schema (clean, no @-keys). */
export const TableConceptsSchema = z.object({
  classPrefLabel: z.string().describe('Concise business name of the entity this table represents.'),
  classAltLabels: z.array(z.string()).describe('Synonyms an analyst might use for this entity.'),
  classComment: z.string().describe('One-sentence description of the entity.'),
  properties: z
    .array(
      z.object({
        column: z.string().describe('The exact column name from the table.'),
        prefLabel: z.string().describe('Business name of the attribute.'),
        altLabels: z.array(z.string()).describe('Synonyms for the attribute.'),
        comment: z.string().describe('One-sentence description of the attribute.'),
      }),
    )
    .describe('One entry per column.'),
});
export type TableConcepts = z.infer<typeof TableConceptsSchema>;

const humanize = (name: string): string =>
  name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

function mapTableToConcepts(table: Table, extracted: TableConcepts): ConceptCandidate[] {
  const out: ConceptCandidate[] = [
    {
      source: { table: table.name },
      ontologyKind: 'Class',
      prefLabel: extracted.classPrefLabel,
      altLabel: extracted.classAltLabels,
      rdfsLabel: extracted.classPrefLabel,
      rdfsComment: extracted.classComment,
    },
  ];

  const byColumn = new Map(extracted.properties.map((p) => [p.column, p]));
  for (const col of table.columns) {
    const p = byColumn.get(col.name);
    out.push({
      source: { table: table.name, column: col.name },
      ontologyKind: 'DatatypeProperty',
      prefLabel: p?.prefLabel ?? humanize(col.name),
      altLabel: p?.altLabels ?? [],
      rdfsLabel: p?.prefLabel ?? humanize(col.name),
      rdfsComment: p?.comment ?? col.comment ?? `The ${humanize(col.name)} of a ${extracted.classPrefLabel}.`,
    });
  }
  return out;
}

export function createConceptExtractNode(llm: StructuredLlm) {
  return async function conceptExtract(state: OntologyState): Promise<OntologyStateUpdate> {
    const schema: CanonicalSchema | null = state.canonicalSchema;
    if (!schema) throw new Error('concept-extract: canonicalSchema is missing (node 1 did not run).');

    const priorErrors = (state.validationErrors ?? []).map((e) => `[${e.rule}] ${e.subject}: ${e.message}`);

    const candidates: ConceptCandidate[] = [];
    for (const table of schema.tables) {
      const user = await buildConceptExtractPrompt(table, schema.foreignKeys, priorErrors);
      const extracted = await llm.generate(TableConceptsSchema, CONCEPT_EXTRACT_SYSTEM, user);
      candidates.push(...mapTableToConcepts(table, extracted));
    }

    // This node is the retry entry point: when re-entered with prior validation
    // errors present, count one retry. Keeping the counter here lets node 5 stay a
    // pure validator and keeps retryCount in {0,1,2} matching the bound exactly.
    const isRetry = (state.validationErrors ?? []).length > 0;
    return isRetry
      ? { conceptCandidates: candidates, retryCount: state.retryCount + 1 }
      : { conceptCandidates: candidates };
  };
}
