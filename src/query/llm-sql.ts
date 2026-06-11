/**
 * Grounded LLM SQL tier (Sprint 4b, focused in Sprint 5).
 *
 * The deterministic linker can't resolve named entities ("Lewis Hamilton", "Malaysian
 * Grand Prix") — they live as high-cardinality data values, not schema labels. This
 * tier hands an LLM a *focused* ontology slice (the relevant tables, sample values,
 * metric formulas, and the pre-resolved join path — see `grounding.ts`) and asks it
 * for one PostgreSQL SELECT. The LLM may use ONLY that slice, so it stays anchored to
 * the real schema while consuming a fraction of the tokens a full-schema dump would.
 *
 * No DB execution — that is Sprint 3d.
 */
import { z } from 'zod';
import type { OntologyIndex } from './ontology-index.js';
import type { QueryIntent } from '../types/query-intent.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import { LLM_SQL_SYSTEM, buildLlmSqlPrompt } from '../prompts/llm-sql.js';
import { buildFocusedGrounding, type GroundingStats, type SliceOptions } from './grounding.js';

/** Structured output: the SQL, the tables it touches, and a one-line rationale. */
export const LlmSqlSchema = z.object({
  sql: z.string().describe('One PostgreSQL SELECT statement.'),
  tables: z.array(z.string()).describe('Tables the SQL reads from.'),
  rationale: z.string().describe('One-line explanation of the chosen joins/filters.'),
});
export type LlmSqlResult = z.infer<typeof LlmSqlSchema>;

/**
 * The deterministic intent is untrustworthy when it left content tokens unresolved, has
 * nothing to SELECT (no projection and no measure), or linked no tables. A useful signal
 * for callers deciding whether to trust the deterministic SQL fast-path.
 */
export function isIntentWeak(intent: QueryIntent): boolean {
  return (
    intent.unresolved.length > 0 ||
    (intent.projection.length === 0 && intent.measures.length === 0) ||
    intent.tables.length === 0
  );
}

/**
 * Generate SQL with the grounded LLM tier, fed the focused ontology slice for the
 * question. Returns the structured SQL plus the grounding token stats (slice vs full).
 */
export async function generateSqlWithLlm(
  question: string,
  index: OntologyIndex,
  llm: StructuredLlm,
  opts: SliceOptions = {},
): Promise<LlmSqlResult & { stats: GroundingStats }> {
  const { grounding, stats } = buildFocusedGrounding(question, index, opts);
  const user = await buildLlmSqlPrompt(grounding, question);
  const out = await llm.generate(LlmSqlSchema, LLM_SQL_SYSTEM, user);
  return { ...out, stats };
}
