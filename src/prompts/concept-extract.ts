/**
 * Prompt for node 2 (concept-extract). One call per table: produce the OWL class
 * for the table plus an OWL/SKOS property for each column, with business-vocabulary
 * synonyms (SKOS altLabels).
 */
import { PromptTemplate } from '@langchain/core/prompts';
import type { Table, ForeignKey } from '../types/canonical-schema.js';

export const CONCEPT_EXTRACT_SYSTEM = [
  'You are an ontology engineer building an OWL + SKOS semantic layer over a relational database.',
  'For one table you produce: (1) an OWL class describing the business entity the table represents,',
  'and (2) one property per column. For every concept give a human prefLabel, a list of business-vocabulary',
  'synonyms (altLabel — words an analyst might say instead), and a one-sentence description.',
  'Use the column comments and sample values as evidence. Prefer business meaning over literal column names',
  '(e.g. a "total_amount" column on an orders table is the "order total"). Keep prefLabels concise and unique',
  'within the table. Return ONLY the requested structured output.',
].join(' ');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['tableName', 'tableComment', 'columns', 'foreignKeys', 'samples', 'priorErrors'],
  template: `Table: {tableName}
Table comment: {tableComment}

Columns (name | type | nullable | comment):
{columns}

Foreign keys originating from this table:
{foreignKeys}

Up to 5 sample rows (JSON):
{samples}
{priorErrors}
Produce the class for this table and one property per column listed above.`,
});

function formatColumns(table: Table): string {
  return table.columns
    .map((c) => `- ${c.name} | ${c.type} | ${c.nullable ? 'nullable' : 'not null'} | ${c.comment ?? '(no comment)'}`)
    .join('\n');
}

function formatForeignKeys(table: Table, fks: ForeignKey[]): string {
  const own = fks.filter((fk) => fk.sourceTable === table.name);
  if (own.length === 0) return '(none)';
  return own.map((fk) => `- ${fk.sourceColumn} -> ${fk.targetTable}.${fk.targetColumn}`).join('\n');
}

/** Build the user prompt for one table. `priorErrors` is injected on a retry pass. */
export async function buildConceptExtractPrompt(
  table: Table,
  fks: ForeignKey[],
  priorErrors: string[],
): Promise<string> {
  const priorErrorsBlock =
    priorErrors.length > 0
      ? `\nThe previous attempt failed validation with these errors — fix them this time:\n${priorErrors
          .map((e) => `- ${e}`)
          .join('\n')}\n`
      : '\n';
  return USER_TEMPLATE.format({
    tableName: table.name,
    tableComment: table.comment ?? '(no comment)',
    columns: formatColumns(table),
    foreignKeys: formatForeignKeys(table, fks),
    samples: JSON.stringify(table.sampleRows, null, 0),
    priorErrors: priorErrorsBlock,
  });
}
