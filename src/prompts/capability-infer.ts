/**
 * Prompt for node 4 (capability-infer). One call over the whole schema + concepts
 * + relationships: propose analytical capabilities (metrics, time grains, fact
 * tables, dimensions). Includes a worked "revenue" example so the model patterns
 * a metric definition correctly.
 */
import { PromptTemplate } from '@langchain/core/prompts';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnFact } from '../types/column-fact.js';
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
  'For every metric also set preferredDirection — whether a LARGER value is the better/more-extreme one:',
  '"higher" (revenue, points, lap speed, GPA, balance) or "lower" (debt, default rate, dropout rate, lap time,',
  'delay, error count). This is the domain polarity behind "best/worst/fastest/slowest"; set it from meaning,',
  'not column type. Use null for non-metrics.',
  '',
  'Worked example of a metric — revenue:',
  '  kind=metric, table=orders, prefLabel="revenue", altLabels=["turnover","top-line"],',
  '  formulaHint="SUM(orders.total_amount) - COALESCE(SUM(refunds.amount), 0)", unit="EUR", preferredDirection="higher".',
  '',
  'CUMULATIVE measures: some columns hold running totals (standings points/wins carried race to',
  'race). NEVER SUM a column listed as cumulative below — SUM double-counts. Use MAX (the final',
  'value per group), or last-value-per-group semantics; phrase the formulaHint accordingly',
  '(e.g. MAX(driverstandings.points) per driver, noting it assumes monotonicity).',
  'Return ONLY the requested structured output.',
].join('\n');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['tables', 'relationships', 'concepts', 'cumulative', 'priorErrors'],
  template: `Schema (table -> columns with types):
{tables}

FK-derived relationships:
{relationships}

Business concepts already extracted (class / property prefLabels):
{concepts}

Cumulative columns — running totals; never SUM these:
{cumulative}
{priorErrors}
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

export interface CapabilityPromptContext {
  /** Columns tagged cumulative-snapshot — the model must never SUM these. */
  columnFacts?: ColumnFact[];
  /** Prior capability validation errors, injected on a retry pass. */
  priorErrors?: string[];
}

function formatCumulative(columnFacts: ColumnFact[]): string {
  const cols = columnFacts.filter((f) => f.temporality === 'cumulative-snapshot');
  if (cols.length === 0) return '(none)';
  return cols.map((f) => `- ${f.table}.${f.column}${f.temporalityEvidence ? ` (${f.temporalityEvidence})` : ''}`).join('\n');
}

export async function buildCapabilityInferPrompt(
  schema: CanonicalSchema,
  concepts: ConceptCandidate[],
  relationships: Relationship[],
  ctx: CapabilityPromptContext = {},
): Promise<string> {
  const priorErrors = ctx.priorErrors ?? [];
  const priorErrorsBlock =
    priorErrors.length > 0
      ? `\nThe previous attempt produced metric formulas that failed validation — fix them this time:\n${priorErrors
          .map((e) => `- ${e}`)
          .join('\n')}\n`
      : '\n';
  return USER_TEMPLATE.format({
    tables: formatTables(schema),
    relationships: formatRelationships(relationships),
    concepts: formatConcepts(concepts),
    cumulative: formatCumulative(ctx.columnFacts ?? []),
    priorErrors: priorErrorsBlock,
  });
}
