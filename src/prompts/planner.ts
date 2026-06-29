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
import type { ColumnProp, SubgraphPayload } from '../query/graph-model.js';
import { payloadIris, payloadColumnByIri, isEnumerable } from '../query/ir.js';
import { tableOfClassIri } from '../query/graph-build.js';

export const PLANNER_PROMPT_VERSION = 'planner/v2';

export const PLANNER_SYSTEM_V2 = [
  'You convert a natural-language question into a typed QUERY (a MetricQueryIR) over the',
  'given subgraph. You do NOT write SQL and you do NOT choose joins — a deterministic compiler',
  'renders the SQL and the joins are ALREADY fixed by the subgraph (shown for context only).',
  '',
  'FIRST pick the QUERY SHAPE — emit ONLY that shape\'s fields:',
  '1. PROJECTION — the question just asks to read columns ("what is X", "list the names …").',
  '     Fill "select" (+ optional "filters"). NO measures, NO groupBy. Add "distinct": true when',
  '     the question wants unique rows ("the coordinates of …").',
  '2. RANKING — "the oldest", "the best", "top N", "first/last by …". A projection that ALSO',
  '     orders: fill "select" + "orderBy" (by a property) + usually "limit". NO aggregate.',
  '3. AGGREGATION — the question asks to COMPUTE a number ("how many", "average", "total per X").',
  '     Fill "measures" (+ optional "groupBy"). This is the ONLY shape that uses measures/groupBy.',
  'A query is EXACTLY ONE shape: never emit both "select" and "measures"; "groupBy" only with measures.',
  '',
  'Slots:',
  '- select (projection/ranking): [{ "property": "<property IRI>" }] — the columns to return.',
  '- distinct (projection/ranking, optional): true to deduplicate rows.',
  '- measures (aggregation, >=1): EXACTLY ONE of the two forms per measure —',
  '    { "capability": "<capability IRI>" }  → use a named metric from the CAPABILITIES menu, or',
  '    { "aggExpr": { "fn": "COUNT|SUM|AVG|MIN|MAX", "property": "<property IRI>" } } → an ad-hoc aggregate.',
  '    Optionally add "alias": "<snake_case>". Never set both capability and aggExpr on one measure.',
  '- groupBy (aggregation, optional): [{ "property": "<property IRI>" }] — the "per X" / "by X" dimensions.',
  '- filters (optional): [{ "property": "<property IRI>", "op": "=|!=|<|<=|>|>=|IN|LIKE", "value": ... }]',
  '    value is a bare string/number, or an array of strings for IN. Do not quote.',
  '- orderBy (optional): [{ "byAlias": "<a measure alias>" OR "byProperty": "<property IRI>", "dir": "ASC|DESC",',
  '    "nulls": "FIRST|LAST" (optional) }] — exactly one of byAlias / byProperty per term.',
  '- limit (optional): a positive integer.',
  '',
  'EXAMPLES:',
  '- "What are the coordinates of Silverstone Circuit?" (projection) →',
  '    { "select": [{ "property": "qsl:property/circuits/lat" }, { "property": "qsl:property/circuits/lng" }],',
  '      "distinct": true, "filters": [{ "property": "qsl:property/circuits/name", "op": "=", "value": "Silverstone Circuit" }] }',
  '- "Which country is the oldest driver from?" (ranking) →',
  '    { "select": [{ "property": "qsl:property/drivers/nationality" }],',
  '      "orderBy": [{ "byProperty": "qsl:property/drivers/dob", "dir": "ASC" }], "limit": 1 }',
  '',
  'HARD RULES:',
  '- Use ONLY the capability IRIs and property IRIs listed in the menu below — verbatim. Never invent',
  '  an IRI, a table, or a column. An IRI not in the menu will be REJECTED.',
  '- Do NOT emit joins, tables, FROM clauses, or SQL. The MetricQueryIR has no join field.',
  '- In the AGGREGATION shape, prefer a named CAPABILITY over an ad-hoc aggExpr when one matches.',
].join('\n');

/** `qsl:property/<table>/<column>` -> "<table>.<column>" for human-readable menu lines. */
function propLabel(iri: string): string {
  const parts = iri.split('/');
  const column = parts[parts.length - 1] ?? '';
  const table = parts[parts.length - 2] ?? '';
  return `${table}.${column}`;
}

/**
 * Char cap for a rendered column description (ADR-010). Char-cap (not first-sentence) so trailing
 * directional hints / ranges survive truncation; env-overridable because another DB's comments may be
 * longer than this fixture's. Generous enough that every formula1 comment renders intact.
 */
const DESC_CAP = (() => {
  const v = Number(process.env.QUERY_MENU_DESC_CAP);
  return Number.isFinite(v) && v > 0 ? v : 160;
})();
const trimDesc = (d: string): string => (d.length <= DESC_CAP ? d : `${d.slice(0, DESC_CAP).trimEnd()}…`);
/** Enumerable sample values surfaced per property line (cap mirrors the option-pool cap). */
const SAMPLE_CAP = 15;

/**
 * One property menu line, enriched with the column's surfaced semantics (ADR-010 / ADR-013): prefLabel +
 * grain tag + description + (enumerable only) sample values. Bridge-table (non-terminal) columns render
 * TERSE (label only) — they are join context, not selection targets, and their samples were already
 * trimmed by Stage 2. The base `- <table>.<col> — IRI: <iri>` head is unchanged, so the offered IRI
 * set (menu == leash) is identical; only human-readable annotations are appended.
 *
 * The `[cumulative snapshot]` grain tag (ADR-013) surfaces `qsl:temporality` — the distinguisher the
 * model needs to tell a running-total column (aggregate with MAX, not SUM) from a per-row column. It is
 * rendered generically (hyphens → spaces) from whatever value the ontology carries, so it disambiguates
 * same-surface-name columns for ANY DB, with no hardcoded strings.
 */
function renderPropLine(iri: string, cp: ColumnProp | undefined, isBridge: boolean): string {
  let line = `- ${propLabel(iri)} — IRI: ${iri}`;
  if (cp?.prefLabel) line += ` — "${cp.prefLabel}"`;
  if (isBridge) return line; // bridge columns: label only (context, not a selection target)
  if (cp?.temporality) line += ` [${cp.temporality.replace(/-/g, ' ')}]`;
  if (cp?.description) line += ` — ${trimDesc(cp.description)}`;
  if (cp && isEnumerable(cp)) {
    const shown = cp.sampleValues.slice(0, SAMPLE_CAP).join(', ');
    const more = cp.sampleValues.length > SAMPLE_CAP ? ` (+${cp.sampleValues.length - SAMPLE_CAP} more)` : '';
    line += ` — values: ${shown}${more}`;
  }
  return line;
}

/** Compact, deterministic rendering of the payload: the capability + property menu + read-only joins. */
export function renderPayloadMenu(payload: SubgraphPayload): string {
  const { properties, capabilities } = payloadIris(payload);
  const colByIri = payloadColumnByIri(payload);
  const bridgeTables = new Set(payload.bridgeNodes.map(tableOfClassIri));

  const capLines = payload.capabilities
    .filter((c) => capabilities.has(c.iri))
    .map((c) => {
      const label = c.prefLabel ?? c.iri.split('/').pop() ?? c.iri;
      const unit = c.unit ? ` [unit: ${c.unit}]` : '';
      return `- ${label}${unit} — IRI: ${c.iri}`;
    });

  const propLines = [...properties].sort().map((iri) => {
    const table = iri.split('/').slice(-2)[0] ?? '';
    return renderPropLine(iri, colByIri.get(iri), bridgeTables.has(table));
  });

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
