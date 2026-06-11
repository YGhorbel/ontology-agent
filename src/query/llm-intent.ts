/**
 * Grounded LLM intent tier (Sprint 6) — the fix for the brittle lexical linker.
 *
 * `linkQuestion` ([schema-linker.ts]) matches question spans to the ontology by string
 * similarity only ("category 1" in the NL2SQL surveys), so it mis-binds paraphrases and
 * leaves content tokens unresolved. Following LB-KBQA (LLM intent tier), Rethinking
 * Schema Linking (LLM emits a structured intent), and LinkQ (the model proposes *names*,
 * the system resolves them to ground-truth schema elements), this tier hands an LLM the
 * focused ontology slice and asks it to fill the SAME typed `QueryIntent`. We then
 * GROUND that output against the index — every table/column must exist, hallucinations
 * are dropped, and genuinely ambiguous spans become a clarification question instead of
 * a guess. The deterministic `intentToSql` renders the SQL: LLM understands, code renders.
 *
 * `resolveIntent` uses the LLM intent DIRECTLY when an LLM is supplied — the grounded LLM
 * output IS the intent (no merge with the deterministic linker). `groundLlmIntent` still
 * validates every table/column against the index, so the model can't hallucinate schema.
 * The deterministic linker is the fallback when no LLM is available, and it also
 * authoritatively binds a span the user has manually disambiguated via a `\pick` alias hint.
 */
import { z } from 'zod';
import type { OntologyIndex } from './ontology-index.js';
import type {
  QueryIntent,
  LinkCandidate,
  ElementRef,
  LinkHints,
} from '../types/query-intent.js';
import { QueryIntentSchema } from '../types/query-intent.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import { buildFocusedGrounding, type GroundingStats, type SliceOptions } from './grounding.js';
import { linkQuestion } from './schema-linker.js';
import { buildLinkTargets, type LinkTarget } from './link-surface.js';
import { LLM_INTENT_SYSTEM, buildLlmIntentPrompt } from '../prompts/llm-intent.js';

const RefSchema = z.object({ table: z.string(), column: z.string().optional() });

/**
 * LLM-friendly subset of `QueryIntent`. Omits the internal bookkeeping the deterministic
 * linker records (`score`/`via`/`matchedSample`/`kind`) — `groundLlmIntent` reconstructs
 * those from the index, so the model only states intent, never bookkeeping.
 */
export const LlmIntentSchema = z.object({
  tables: z.array(z.string()).default([]).describe('Tables whose columns are referenced (minimal set).'),
  projection: z.array(z.object({ table: z.string(), column: z.string() })).default([]).describe('Plain attribute columns to SELECT (not aggregates).'),
  measures: z.array(z.object({ table: z.string(), column: z.string(), capability: z.string().optional() })).default([]).describe('Metric to aggregate; capability = the metric prefLabel.'),
  groupDims: z.array(z.object({ table: z.string(), column: z.string() })).default([]).describe('GROUP BY columns (only alongside a measure).'),
  filters: z.array(z.object({ table: z.string(), column: z.string(), op: z.enum(['=', 'in']).default('='), value: z.string() })).default([]).describe('WHERE clauses; bare unquoted value.'),
  orderBy: z.array(z.object({ table: z.string(), column: z.string(), dir: z.enum(['asc', 'desc']) })).default([]).describe('ORDER BY terms.'),
  limit: z.number().int().positive().nullable().default(null).describe('LIMIT, or null.'),
  ambiguities: z.array(z.object({
    span: z.string(),
    candidates: z.array(RefSchema).default([]),
    clarification: z.string().default(''),
  })).default([]).describe('Spans mapping to >1 element — with a clarification question, NOT a guess.'),
  unresolved: z.array(z.string()).default([]).describe('Question content words not found in the grounding.'),
  rationale: z.string().default('').describe('One-line explanation.'),
});
export type LlmIntent = z.infer<typeof LlmIntentSchema>;

/** A genuine ambiguity the caller should resolve with the user before trusting the intent. */
export interface Clarification {
  span: string;
  options: ElementRef[];
  question: string;
}

export interface GroundedIntent {
  intent: QueryIntent;
  warnings: string[];
  clarification?: Clarification;
}

export interface LlmIntentResult extends GroundedIntent {
  stats: GroundingStats;
}

/** Optional trace sink — receives one human-readable line per pipeline step. */
export type IntentLogger = (msg: string) => void;

export interface ResolveOptions {
  llm?: StructuredLlm | null;
  hints?: LinkHints;
  slice?: SliceOptions;
  /** When set, narrates retrieve → llm → validate (off by default; silent in tests). */
  log?: IntentLogger;
}

export interface ResolvedIntent {
  intent: QueryIntent;
  /** `llm` = grounded LLM intent; `deterministic` = no LLM, it failed, or a manual `\pick`. */
  source: 'deterministic' | 'llm';
  stats?: GroundingStats;
  warnings?: string[];
  clarification?: Clarification;
  /** Set when the LLM tier was attempted but failed and we fell back to deterministic. */
  error?: string;
}

const refKey = (ref: ElementRef): string => `${ref.table}.${ref.column ?? ''}`;
const eqValue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Ground an LLM-proposed intent against the ontology: drop hallucinated tables/columns,
 * fill `matchedSample`, rebuild `ambiguities` as `LinkCandidate`s, cross-check filter
 * values against the value dictionaries, and surface the first genuine ambiguity as a
 * clarification. Returns a schema-valid `QueryIntent`.
 */
export function groundLlmIntent(question: string, llmIntent: LlmIntent, index: OntologyIndex): GroundedIntent {
  const warnings: string[] = [];
  const tableExists = (t: string): boolean => index.columnsByTable.has(t);
  const colExists = (t: string, c: string): boolean => index.columnsByTable.get(t)?.some((col) => col.column === c) ?? false;
  const sampleOf = (t: string, c: string): string[] => index.columnsByTable.get(t)?.find((col) => col.column === c)?.sampleValues ?? [];

  const keepCol = (table: string, column: string, where: string): boolean => {
    if (!tableExists(table)) { warnings.push(`dropped ${where} ${table}.${column}: unknown table`); return false; }
    if (!colExists(table, column)) { warnings.push(`dropped ${where} ${table}.${column}: unknown column`); return false; }
    return true;
  };

  // Foreign-key columns are join plumbing — like the deterministic linker, they never
  // surface as a projection or group-by ([schema-linker.ts] fkCols / isPk).
  const fkCols = new Set(index.joinEdges.map((e) => `${e.fromTable}.${e.fromColumn}`));
  const isPk = (t: string, c: string): boolean => Boolean(index.columnsByTable.get(t)?.find((col) => col.column === c)?.isPrimaryKey);

  const measures = llmIntent.measures
    .filter((m) => keepCol(m.table, m.column, 'measure'))
    .map((m) => ({ table: m.table, column: m.column, ...(m.capability ? { capability: m.capability } : {}) }));
  const orderBy = llmIntent.orderBy.filter((o) => keepCol(o.table, o.column, 'orderBy'));
  const filters = llmIntent.filters
    .filter((f) => keepCol(f.table, f.column, 'filter'))
    .map((f) => ({
      table: f.table,
      column: f.column,
      op: f.op,
      value: f.value,
      matchedSample: sampleOf(f.table, f.column).some((v) => eqValue(v, f.value)),
    }));

  const measureKeys = new Set(measures.map(refKey));
  const filterKeys = new Set(filters.map(refKey));
  const orderKeys = new Set(orderBy.map(refKey));

  // M2 — group dimensions: never an FK or a filtered column, and meaningless without a measure.
  let groupDims = llmIntent.groupDims
    .filter((g) => keepCol(g.table, g.column, 'groupDim'))
    .filter((g) => !fkCols.has(refKey(g)) && !filterKeys.has(refKey(g)));
  if (measures.length === 0) groupDims = [];
  const groupKeys = new Set(groupDims.map(refKey));

  // M1 — projection: plain attributes only. Exclude anything already used as a
  // measure/group-by/filter/order-by, and any key/foreign-key column (matches the linker).
  const projection = llmIntent.projection
    .filter((p) => keepCol(p.table, p.column, 'projection'))
    .filter((p) => !measureKeys.has(refKey(p)) && !groupKeys.has(refKey(p)) && !filterKeys.has(refKey(p)) && !orderKeys.has(refKey(p)))
    .filter((p) => !isPk(p.table, p.column) && !fkCols.has(refKey(p)));

  const tableSet = new Set<string>();
  for (const t of llmIntent.tables) {
    if (tableExists(t)) tableSet.add(t);
    else warnings.push(`dropped table ${t}: unknown`);
  }
  for (const r of [...projection, ...measures, ...groupDims, ...orderBy, ...filters]) tableSet.add(r.table);

  // Reconstruct LinkCandidates (kind/role come from the index, not the LLM).
  const targetByRef = new Map<string, LinkTarget>();
  for (const t of buildLinkTargets(index)) {
    const k = refKey(t.ref);
    if (!targetByRef.has(k)) targetByRef.set(k, t);
  }
  const toCandidate = (ref: ElementRef): LinkCandidate => {
    const tgt = targetByRef.get(refKey(ref));
    return {
      ref,
      kind: tgt?.kind ?? (ref.column ? 'column' : 'class'),
      role: tgt?.role ?? 'attribute',
      score: 0.9,
      via: 'name',
    };
  };

  const ambiguities: QueryIntent['ambiguities'] = [];
  let clarification: Clarification | undefined;

  // LLM-flagged ambiguities escalate to a clarifying question (the LinkQ contract).
  for (const a of llmIntent.ambiguities) {
    const cands = a.candidates.filter((c) => tableExists(c.table) && (!c.column || colExists(c.table, c.column)));
    if (cands.length < 2) continue; // not actually ambiguous once grounded
    ambiguities.push({ span: a.span, candidates: cands.map(toCandidate) });
    if (!clarification) {
      clarification = { span: a.span, options: cands, question: a.clarification || `Which "${a.span}" did you mean?` };
    }
  }

  // Value-dictionary cross-check: a filter value living in >1 column is surfaced for
  // visibility (non-blocking — the LLM already chose, so we don't re-prompt on these).
  for (const f of filters) {
    const hits: ElementRef[] = [];
    for (const [t, cols] of index.columnsByTable) {
      for (const col of cols) {
        if ((col.sampleValues ?? []).some((v) => eqValue(v, f.value))) hits.push({ table: t, column: col.column });
      }
    }
    const distinct = hits.filter((r, i) => hits.findIndex((x) => refKey(x) === refKey(r)) === i);
    if (distinct.length >= 2 && !ambiguities.some((a) => a.span === f.value)) {
      ambiguities.push({ span: f.value, candidates: distinct.map(toCandidate) });
    }
  }

  const intent = QueryIntentSchema.parse({
    question,
    tables: [...tableSet],
    projection,
    measures,
    groupDims,
    filters,
    orderBy,
    limit: llmIntent.limit,
    ambiguities,
    unresolved: llmIntent.unresolved,
  });

  return { intent, warnings, ...(clarification ? { clarification } : {}) };
}

/** Run the LLM intent tier: focused grounding → LLM → grounded typed intent + token stats. */
export async function generateIntentWithLlm(
  question: string,
  index: OntologyIndex,
  llm: StructuredLlm,
  opts: SliceOptions & { log?: IntentLogger } = {},
): Promise<LlmIntentResult> {
  const log = opts.log;
  // ① RETRIEVE — the ontology slice the linker + join-graph selected for this question.
  const { grounding, slice, stats } = buildFocusedGrounding(question, index, opts);
  log?.(`① retrieve: slice ${slice.tables.length} table(s) [${slice.tables.join(', ')}] · grounding ${stats.sliceTokens} tok (-${stats.reductionPct}% vs full ${stats.fullTokens})`);
  if (slice.intent.unresolved.length > 0) log?.(`   linker left unresolved: [${slice.intent.unresolved.join(', ')}]`);

  // ② LLM — the model fills the typed intent reading only that grounding.
  const user = await buildLlmIntentPrompt(grounding, question);
  const raw = await llm.generate(LlmIntentSchema, LLM_INTENT_SYSTEM, user);
  const llmIntent = LlmIntentSchema.parse(raw); // apply zod defaults → output type
  log?.(`② llm: tables=[${llmIntent.tables.join(', ')}] measures=${llmIntent.measures.length} filters=${llmIntent.filters.length} projection=${llmIntent.projection.length} orderBy=${llmIntent.orderBy.length} limit=${llmIntent.limit ?? '—'} ambiguities=${llmIntent.ambiguities.length}`);

  // ③ VALIDATE — drop anything not in the ontology, set matchedSample, find ambiguities.
  const grounded = groundLlmIntent(question, llmIntent, index);
  for (const w of grounded.warnings) log?.(`③ validate: ${w}`);
  if (grounded.clarification) log?.(`③ validate: clarification on "${grounded.clarification.span}" (${grounded.clarification.options.length} options)`);
  log?.(`③ validate: kept ${grounded.intent.measures.length} measure(s), ${grounded.intent.filters.length} filter(s) over [${grounded.intent.tables.join(', ')}]`);
  return { ...grounded, stats };
}

/**
 * Resolve a question to a typed intent. When an LLM is supplied, the grounded LLM intent
 * IS the result (source `llm`) — no merge with the deterministic linker. The deterministic
 * linker is used only when no LLM is available, or when the user has manually disambiguated
 * a span via a `\pick` alias hint (which the deterministic alias channel binds
 * authoritatively, so the pick is honoured rather than re-guessed by the model).
 */
export async function resolveIntent(
  question: string,
  index: OntologyIndex,
  opts: ResolveOptions = {},
): Promise<ResolvedIntent> {
  const log = opts.log;
  const hasPick = (opts.hints?.aliases?.length ?? 0) > 0;

  // No LLM, or the user just made a manual pick → use the deterministic linker (it honours
  // the alias hint). Otherwise the LLM intent is authoritative.
  if (!opts.llm || hasPick) {
    log?.(`resolve "${question}" → deterministic (${!opts.llm ? 'no llm' : 'manual pick'})`);
    const det = linkQuestion(question, index, opts.hints ? { hints: opts.hints } : {});
    return { intent: det, source: 'deterministic' };
  }

  try {
    log?.(`resolve "${question}" → llm`);
    const r = await generateIntentWithLlm(question, index, opts.llm, { ...(opts.slice ?? {}), ...(log ? { log } : {}) });
    return {
      intent: r.intent,
      source: 'llm',
      stats: r.stats,
      warnings: r.warnings,
      ...(r.clarification ? { clarification: r.clarification } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`llm failed (${msg}) → deterministic fallback`);
    const det = linkQuestion(question, index, opts.hints ? { hints: opts.hints } : {});
    return { intent: det, source: 'deterministic', error: msg };
  }
}

/** Turn a user's disambiguation pick into an alias hint that binds the span on re-resolve. */
export function pickHint(span: string, ref: ElementRef): LinkHints {
  return { aliases: [{ phrase: span, ref }], values: [], orderBy: [], limit: null };
}
