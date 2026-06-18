/**
 * Prompt for the grounded LLM intent tier (Sprint 6). The model receives the focused
 * ontology slice (the relevant tables, columns, sample values, metric formulas, and
 * foreign keys — built by `buildFocusedGrounding`) and the question, and returns a
 * *typed intent* (projection / measures / group-by / filters / order / limit), NOT raw
 * SQL. The deterministic `intentToSql` then renders the SQL — the model does the
 * understanding, the deterministic layer does the rendering.
 *
 * This is the LB-KBQA "LLM intent" tier and the LinkQ contract: the model proposes
 * entity/metric *names*; the system resolves them to real schema elements. Two rules
 * matter most — (1) use ONLY names present in the grounding (no hallucinated columns),
 * and (2) when a phrase plausibly maps to more than one element, do NOT guess: surface
 * the candidates with a one-line clarification question so the user can disambiguate.
 */
import { PromptTemplate } from '@langchain/core/prompts';

export const LLM_INTENT_SYSTEM = [
  'You convert a natural-language question into a STRUCTURED QUERY INTENT over the given ontology.',
  'You do NOT write SQL. You fill typed slots; a deterministic renderer turns them into SQL.',
  'Use ONLY table and column names that appear verbatim in the grounding — never invent names.',
  '',
  'Fill the slots from the question:',
  '- tables: every table whose columns you reference (keep it minimal — only what the answer needs).',
  '- projection: plain attribute columns the question asks to SEE (e.g. a name/reference), not aggregates.',
  '- measures: a metric to aggregate — give {table, column, capability} using the metric\'s prefLabel as',
  '  capability so its declared formula is used. Use measures only when the question asks to aggregate.',
  '  A column marked "~cumulative" is a running total (a snapshot AFTER each event), so it is a',
  '  LAST-value, not a sum — only choose it as a measure when the question really wants that total.',
  '- groupDims: columns to GROUP BY (present only alongside a measure, e.g. "per X" / "by X").',
  '- filters: column = value (or op "in" for a set). Resolve named entities to the right TEXT column and',
  '  literal value — split a full person name into separate filters (forename + surname). Quote nothing;',
  '  give the bare value. Prefer values shown in the column\'s sample values when one matches.',
  '- orderBy + limit: for "best/worst/fastest/slowest/top/most/least" order by the relevant metric and set',
  '  a limit. Apply the metric\'s preferred direction: "higher is better" → desc, "lower is better" → asc;',
  '  a single-row superlative ("the fastest X") uses limit 1.',
  '- unresolved: question content words you could not map to any element in the grounding.',
  '- rationale: one line explaining the chosen tables/filters.',
  '',
  'AMBIGUITY — do not guess. When a phrase could map to more than one column or metric (e.g. "position"',
  'exists on several tables, or "date" is ambiguous), add it to `ambiguities` with the candidate elements',
  'and a short `clarification` question ("Which position did you mean — qualifying, race result, or',
  'standings?"). Still fill your best guess in the other slots so the intent stays usable, but the',
  'clarification signals the caller to confirm before trusting it.',
].join('\n');

const USER_TEMPLATE = new PromptTemplate({
  inputVariables: ['grounding', 'question'],
  template: `Ontology grounding (the ONLY schema you may use):
{grounding}

Question: {question}

Return the structured query intent for this question using only the grounding above.`,
});

export async function buildLlmIntentPrompt(grounding: string, question: string): Promise<string> {
  return USER_TEMPLATE.format({ grounding, question });
}
