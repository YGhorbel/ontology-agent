/**
 * Prompt for node 2 (concept-extract). One call per table: produce the OWL class
 * for the table plus an OWL/SKOS property for each column, with business-vocabulary
 * synonyms (SKOS altLabels).
 */
import { PromptTemplate } from '@langchain/core/prompts';
import type { Table, ForeignKey } from '../types/canonical-schema.js';
import type { ColumnFact } from '../types/column-fact.js';
import { enumMaxDistinctFromEnv } from '../profiling/column-facts.js';

export const CONCEPT_EXTRACT_SYSTEM = [
  'You are an ontology engineer building an OWL + SKOS semantic layer over a relational database.',
  'For one table you produce: (1) an OWL class describing the business entity the table represents,',
  'and (2) one property per column. For every concept give a human prefLabel, a list of business-vocabulary',
  'synonyms (altLabel — words an analyst might say instead), and a one-sentence description.',
  'Use the column comments and sample values as evidence. Prefer business meaning over literal column names',
  '(e.g. a "total_amount" column on an orders table is the "order total"). Keep prefLabels concise and unique',
  'within the table.',
  'CRITICAL — ground every description in the data: when you cite an example value in a comment, it MUST be one',
  'of the sample values listed in the "Column profile facts" block for that column. Never invent example values.',
  'If a column has very few distinct values, describe it as that small enumeration. If a sentinel like \'-\', \'\'',
  "or 'N/A' appears in the samples, note it is used for unknown/missing rather than treating it as a real category.",
  'A column flagged "CUMULATIVE" in the profile facts holds a running total as of that event (e.g. championship',
  'points/wins standing after a race), NOT a per-event amount: describe it as a cumulative/running total to date,',
  'never as the value "awarded for this race/entry".',
  'Return ONLY the requested structured output.',
].join(' ');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['tableName', 'tableComment', 'columns', 'profileFacts', 'foreignKeys', 'samples', 'priorErrors'],
  template: `Table: {tableName}
Table comment: {tableComment}

Columns (name | type | nullable | comment):
{columns}

Column profile facts (data-derived — cite example values ONLY from the samples shown here):
{profileFacts}

Foreign keys originating from this table:
{foreignKeys}

Up to 5 sample rows (JSON):
{samples}
{priorErrors}
Produce the class for this table and one property per column listed above.`,
});

/** Number of sample values to surface per enumerated column in the prompt. */
const promptSampleValuesFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_PROMPT_SAMPLE_VALUES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15;
};

/** One profile-facts line per column; sample values only for small enumerations. */
function formatProfileFacts(table: Table, facts: ColumnFact[]): string {
  const byCol = new Map(facts.map((f) => [f.column, f]));
  const enumMax = enumMaxDistinctFromEnv();
  const sampleN = promptSampleValuesFromEnv();
  const lines = table.columns.map((c) => {
    const f = byCol.get(c.name);
    if (!f) return `- ${c.name} | ${c.type}`;
    const parts = [`- ${c.name} | ${f.dataType}`];
    if (f.numRows !== undefined && f.nullCount !== undefined) parts.push(`${f.nullCount}/${f.numRows} null`);
    if (f.distinctCount !== null && f.distinctCount !== undefined) parts.push(`${f.distinctCount} distinct`);
    if (f.min != null || f.max != null) parts.push(`range [${f.min ?? '?'}..${f.max ?? '?'}]`);
    if (
      f.distinctCount !== null &&
      f.distinctCount !== undefined &&
      f.distinctCount <= enumMax &&
      f.sampleValues.length > 0
    ) {
      const shown = f.sampleValues.slice(0, sampleN).map((v) => `'${v}'`).join(', ');
      parts.push(`samples: ${shown}`);
    }
    if (f.nullPlaceholder !== undefined) parts.push(`placeholder-for-unknown: '${f.nullPlaceholder}'`);
    // Part 2d: temporality is computed in 1b before this prompt runs — tell the model so the
    // generated comment describes a running/cumulative total, not a per-event award.
    if (f.temporality === 'cumulative-snapshot') parts.push('CUMULATIVE (running total as-of-event; not a per-event amount)');
    return parts.join(' | ');
  });
  return lines.join('\n');
}

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
  facts: ColumnFact[] = [],
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
    profileFacts: formatProfileFacts(table, facts),
    foreignKeys: formatForeignKeys(table, fks),
    samples: JSON.stringify(table.sampleRows, null, 0),
    priorErrors: priorErrorsBlock,
  });
}
