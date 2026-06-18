/**
 * Prompt for the grounded LLM SQL tier (Sprint 4b). The model receives the ontology
 * serialized as compact schema + metric semantics + join edges (built in
 * `src/query/llm-sql.ts`) and the question, and returns ONE PostgreSQL SELECT.
 *
 * The grounding is what keeps it honest: it may only use the tables, columns, joins,
 * and formulas it is shown — so it resolves named entities ("Lewis Hamilton" →
 * drivers.forename/surname) against the real schema rather than hallucinating.
 */
import { PromptTemplate } from '@langchain/core/prompts';

export const LLM_SQL_SYSTEM = [
  'You translate a natural-language question into exactly ONE PostgreSQL SELECT statement.',
  'Use ONLY the tables, columns, and metric formulas provided in the grounding — never invent names.',
  '',
  'CRITICAL — use the FEWEST tables possible. Start from the single table that holds the answer and',
  'add a JOIN only when the query actually reads or filters a column from another table. The foreign',
  'keys are a REFERENCE for how to join IF needed — they are NOT a path you must follow. Never join a',
  'table whose columns you do not use: extra one-to-many joins multiply rows and corrupt COUNT, SUM,',
  'and percentage results. Most questions need 1–3 tables.',
  '',
  'Resolve named entities (people, teams, places, events) to the right text/name columns and literal',
  'values (e.g. a full name → forename + surname). For a metric, use its given formula; for',
  '"best/worst/fastest/slowest" apply the metric\'s stated preferred direction (higher → ORDER BY DESC,',
  'lower → ASC); single-row superlatives use LIMIT 1. Quote string literals, leave numbers unquoted.',
  '',
  'A column marked "~cumulative" is a running total (e.g. championship points/wins AFTER a race), so',
  'SUMming it double-counts. Take its LAST value per the stated partition instead — MAX per group, or',
  'DISTINCT ON (partition) … ORDER BY the stated sequence column. A metric marked "[llm-inferred —',
  'verify]" is an unvalidated guess; prefer a "[validated]" metric or a plain column when one fits.',
  'Return ONLY the structured output: the SQL, the tables it uses, and a one-line rationale.',
].join('\n');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['grounding', 'question'],
  template: `Ontology grounding (the ONLY schema you may use):
{grounding}

Question: {question}

Write one PostgreSQL SELECT that answers it using only the grounding above.`,
});

export async function buildLlmSqlPrompt(grounding: string, question: string): Promise<string> {
  return USER_TEMPLATE.format({ grounding, question });
}
