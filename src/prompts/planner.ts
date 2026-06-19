/**
 * Stage 3a planner prompt (versioned). The planner LLM receives a question plus a compact
 * rendering of a Stage-2 `SubgraphPayload` and emits a typed `MetricQueryIR` — it chooses
 * only WHAT to compute (measure / groupBy / filter / orderBy / limit), never joins.
 *
 * Versioning: the prompt is a constant tagged with `PLANNER_PROMPT_VERSION` (carried in the
 * planner trace) because we will iterate it. Field semantics live HERE rather than as zod
 * `.describe()` on the IR schema: the planner binds the *base* `MetricQueryIRSchema` (shape
 * only) for structured output and enforces the payload leash with an explicit
 * `specializeIrSchema(payload).safeParse` — so the model is steered by this prompt's IRI
 * menu, and the verified `src/query/ir.ts` is left untouched.
 *
 * The menu is built from `payloadIris(payload)` so the IRIs offered to the model are EXACTLY
 * the IRIs the leash will accept (menu == leash, by construction). The join skeleton is shown
 * as read-only context with an explicit instruction NOT to emit joins (the IR grammar has no
 * join field; join authority belongs to Stage 2).
 */
import type { SubgraphPayload } from '../query/graph-model.js';
import { payloadIris } from '../query/ir.js';
import { tableOfClassIri } from '../query/graph-build.js';

export const PLANNER_PROMPT_VERSION = 'planner/v1';

export const PLANNER_SYSTEM_V1 = [
  'You convert a natural-language question into a typed METRIC QUERY (a MetricQueryIR) over the',
  'given subgraph. You do NOT write SQL and you do NOT choose joins — a deterministic compiler',
  'renders the SQL and the joins are ALREADY fixed by the subgraph (shown for context only).',
  '',
  'You choose only WHAT to compute. Fill these slots:',
  '- measures (required, >=1): EXACTLY ONE of the two forms per measure —',
  '    { "capability": "<capability IRI>" }  → use a named metric from the CAPABILITIES menu, or',
  '    { "aggExpr": { "fn": "COUNT|SUM|AVG|MIN|MAX", "property": "<property IRI>" } } → an ad-hoc aggregate.',
  '    Optionally add "alias": "<snake_case>". Never set both capability and aggExpr on one measure.',
  '- groupBy (optional): [{ "property": "<property IRI>" }] — the "per X" / "by X" dimensions.',
  '- filters (optional): [{ "property": "<property IRI>", "op": "=|!=|<|<=|>|>=|IN|LIKE", "value": ... }]',
  '    value is a bare string/number, or an array of strings for IN. Do not quote.',
  '- orderBy (optional): [{ "byAlias": "<a measure alias>" OR "byProperty": "<property IRI>", "dir": "ASC|DESC" }]',
  '    exactly one of byAlias / byProperty per term.',
  '- limit (optional): a positive integer.',
  '',
  'HARD RULES:',
  '- Use ONLY the capability IRIs and property IRIs listed in the menu below — verbatim. Never invent',
  '  an IRI, a table, or a column. An IRI not in the menu will be REJECTED.',
  '- Do NOT emit joins, tables, FROM clauses, or SQL. The MetricQueryIR has no join field.',
  '- Prefer a named CAPABILITY over an ad-hoc aggExpr when one matches the question.',
].join('\n');

/** `qsl:property/<table>/<column>` -> "<table>.<column>" for human-readable menu lines. */
function propLabel(iri: string): string {
  const parts = iri.split('/');
  const column = parts[parts.length - 1] ?? '';
  const table = parts[parts.length - 2] ?? '';
  return `${table}.${column}`;
}

/** Compact, deterministic rendering of the payload: the capability + property menu + read-only joins. */
export function renderPayloadMenu(payload: SubgraphPayload): string {
  const { properties, capabilities } = payloadIris(payload);

  const capLines = payload.capabilities
    .filter((c) => capabilities.has(c.iri))
    .map((c) => {
      const label = c.prefLabel ?? c.iri.split('/').pop() ?? c.iri;
      const unit = c.unit ? ` [unit: ${c.unit}]` : '';
      return `- ${label}${unit} — IRI: ${c.iri}`;
    });

  const propLines = [...properties].sort().map((iri) => `- ${propLabel(iri)} — IRI: ${iri}`);

  const joinLines = payload.joins.map((j) => {
    const from = tableOfClassIri(j.from);
    const to = tableOfClassIri(j.to);
    const on = j.on.map(([a, b]) => `${from}.${a} = ${to}.${b}`).join(' AND ');
    return `- ${from} ⋈ ${to} ON ${on}`;
  });

  return [
    'CAPABILITIES (named metrics you may reference via "capability"):',
    capLines.length ? capLines.join('\n') : '  (none)',
    '',
    'PROPERTIES (datatype columns you may reference via "property" in aggExpr/groupBy/filter/orderBy):',
    propLines.length ? propLines.join('\n') : '  (none)',
    '',
    'JOINS (FIXED by Stage 2 — context only; DO NOT emit joins):',
    joinLines.length ? joinLines.join('\n') : '  (none)',
  ].join('\n');
}

/** Optional repair context appended on a retry: the previous output and why the leash rejected it. */
export interface RepairContext {
  previous: unknown;
  issues: string[];
}

/** Build the user prompt for a planner invocation (with optional repair feedback). */
export function buildPlannerPrompt(question: string, payload: SubgraphPayload, repair?: RepairContext): string {
  const parts = [
    'Subgraph menu (the ONLY capability/property IRIs you may use):',
    renderPayloadMenu(payload),
    '',
    `Question: ${question}`,
    '',
    'Return the MetricQueryIR for this question using only the IRIs above. Do not emit joins.',
  ];
  if (repair) {
    parts.push(
      '',
      'PREVIOUS_ATTEMPT_FAILED — your previous output did not satisfy the payload leash:',
      JSON.stringify(repair.previous),
      'Validation errors:',
      ...repair.issues.map((i) => `- ${i}`),
      'Fix these and return a corrected MetricQueryIR using only IRIs from the menu above.',
    );
  }
  return parts.join('\n');
}
