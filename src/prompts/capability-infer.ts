/**
 * Prompt for node 4 (capability-infer). One call over the whole schema + concepts
 * + relationships: propose analytical capabilities (metrics, time grains, fact
 * tables, dimensions). Includes a worked "revenue" example so the model patterns
 * a metric definition correctly.
 */
import { PromptTemplate } from '@langchain/core/prompts';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ConceptCandidate, Relationship } from '../types/ontology.js';

export const CAPABILITY_INFER_SYSTEM = [
  'You are a semantic-layer analyst. Given a database schema, its OWL concepts and FK-derived relationships,',
  'annotate the analytical capabilities so a NL-to-SQL agent knows what can be computed.',
  'Identify: metric (a sum-able / average-able measure, with a formulaHint referencing real table.column names',
  'and a unit), timeGrain (a date/timestamp column usable as day/week/month/quarter/year), factTable (a',
  'high-cardinality table that is mostly foreign keys + numeric measures), and dimension (a low-cardinality,',
  'stable lookup table). Always reference real table and column names. Give metrics a prefLabel and business',
  'synonyms (altLabels).',
  '',
  'Worked example of a metric — revenue:',
  '  kind=metric, table=orders, prefLabel="revenue", altLabels=["turnover","top-line"],',
  '  formulaHint="SUM(orders.total_amount) - COALESCE(SUM(refunds.amount), 0)", unit="EUR".',
  'Return ONLY the requested structured output.',
].join('\n');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['tables', 'relationships', 'concepts'],
  template: `Schema (table -> columns with types):
{tables}

FK-derived relationships:
{relationships}

Business concepts already extracted (class / property prefLabels):
{concepts}

Propose the analytical capabilities for this schema.`,
});

function formatTables(schema: CanonicalSchema): string {
  return schema.tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
      return `- ${t.name} (${cols})`;
    })
    .join('\n');
}

function formatRelationships(rels: Relationship[]): string {
  if (rels.length === 0) return '(none)';
  return rels
    .map((r) => `- ${r.source.class} --${r.predicate} (${r.cardinality})--> ${r.target.class}`)
    .join('\n');
}

function formatConcepts(concepts: ConceptCandidate[]): string {
  return concepts
    .map((c) => `- [${c.ontologyKind}] ${c.source.table}${c.source.column ? `.${c.source.column}` : ''} = "${c.prefLabel}"`)
    .join('\n');
}

export async function buildCapabilityInferPrompt(
  schema: CanonicalSchema,
  concepts: ConceptCandidate[],
  relationships: Relationship[],
): Promise<string> {
  return USER_TEMPLATE.format({
    tables: formatTables(schema),
    relationships: formatRelationships(relationships),
    concepts: formatConcepts(concepts),
  });
}
