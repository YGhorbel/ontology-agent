/**
 * Ontology retrieval + grounding (Sprint 5) — the token-reduction layer.
 *
 * Instead of dumping the whole ontology into the LLM prompt, the deterministic linker
 * and join-graph select a small, recall-safe *slice* relevant to the question. We
 * render only that slice, so the LLM is handed the columns and foreign keys it would
 * otherwise have to find — far fewer tokens, and it scales to large schemas.
 *
 * Following RSL-SQL / DAIL-SQL / UNJOIN, foreign keys are presented as a *reference*
 * for the model to pick the minimal set it needs — pre-chaining every slice table into
 * one join path is what causes the over-joining failure. Recall-safe pruning: seeds =
 * linked ∪ value-matched ∪ class-level ambiguous tables, expanded by bounded 1-hop join
 * neighbours, so the right table stays reachable even when the linker mis-binds.
 */
import type { OntologyIndex, ColumnInfo } from './ontology-index.js';
import type { QueryIntent } from '../types/query-intent.js';
import type { JoinPath } from '../types/query-plan.js';
import { linkQuestion } from './schema-linker.js';
import { buildJoinGraph, resolveJoinPath } from './join-graph.js';

export interface OntologySlice {
  /** Tables fed to the LLM (seeds + bounded join neighbours). */
  tables: string[];
  /** Pre-resolved FROM/JOIN over those tables (retained for callers; not rendered). */
  joinPath: JoinPath;
  /** The deterministic intent (its `unresolved` terms become "resolve these" hints). */
  intent: QueryIntent;
}

export interface GroundingStats {
  sliceTokens: number;
  fullTokens: number;
  reductionPct: number;
}

export interface FocusedGrounding {
  grounding: string;
  slice: OntologySlice;
  stats: GroundingStats;
}

export interface SliceOptions {
  /** Max 1-hop neighbour tables added beyond the seeds (default 6). */
  neighborBudget?: number;
}

const MAX_SAMPLES = 5;
const DEFAULT_NEIGHBOR_BUDGET = 6;

/** Cheap token estimate (≈4 chars/token) — no tokenizer dependency. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

function renderColumn(c: ColumnInfo): string {
  const pk = c.isPrimaryKey ? ' PK' : '';
  const label = c.prefLabel && c.prefLabel.toLowerCase() !== c.column.toLowerCase() ? ` "${c.prefLabel}"` : '';
  const samples = c.sampleValues && c.sampleValues.length > 0 ? ` [${c.sampleValues.slice(0, MAX_SAMPLES).join(', ')}]` : '';
  // Cumulative-snapshot columns are running totals: SUMming them double-counts. Tell the LLM the
  // safe aggregation (last value per the stated partition, ordered by the sequence column).
  let cumulative = '';
  if (c.temporality === 'cumulative-snapshot') {
    const ev = c.temporalityEvidence;
    const grain = ev ? ` (last value per ${ev.partitionColumns.join('+')} by ${ev.orderColumn})` : '';
    cumulative = ` ~cumulative${grain}`;
  }
  return `${c.column}${pk}${label}${samples}${cumulative}`;
}

/** Tables one foreign-key hop from `table` (either direction). */
function neighborsOf(table: string, index: OntologyIndex): string[] {
  const out = new Set<string>();
  for (const e of index.joinEdges) {
    if (e.fromTable === table) out.add(e.toTable);
    else if (e.toTable === table) out.add(e.fromTable);
  }
  return [...out];
}

/**
 * Select the relevant ontology slice for a question: seed tables from the linker,
 * expanded by bounded 1-hop join neighbours, with the join path pre-resolved.
 */
export function selectRelevantSlice(question: string, index: OntologyIndex, opts: SliceOptions = {}): OntologySlice {
  const intent = linkQuestion(question, index);

  const seeds = new Set<string>();
  for (const t of intent.tables) seeds.add(t);
  for (const f of intent.filters) seeds.add(f.table);
  // Seed ambiguity candidates only when they are the table/class itself — a generic term
  // like "race" matches a raceid FK on many tables, and seeding all of them bloats the
  // slice with join plumbing. The referenced parent table is reached via neighbours.
  for (const a of intent.ambiguities) for (const c of a.candidates) if (c.kind === 'class') seeds.add(c.ref.table);

  // Recall-safe expansion: pull in join neighbours so a mis-bind doesn't starve the LLM.
  // Expand generously when the linker found few seeds (likely missing an entity table),
  // tightly when it already found several (avoid dragging in the whole schema via hubs).
  const budget = opts.neighborBudget ?? (seeds.size >= 3 ? 2 : DEFAULT_NEIGHBOR_BUDGET);
  const tables = new Set(seeds);
  let added = 0;
  for (const s of seeds) {
    if (added >= budget) break;
    for (const n of neighborsOf(s, index)) {
      if (added >= budget) break;
      if (!tables.has(n)) {
        tables.add(n);
        added += 1;
      }
    }
  }

  const present = [...tables].filter((t) => index.columnsByTable.has(t));
  const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
  const joinPath = resolveJoinPath(buildJoinGraph(index.joinEdges), present, { factTables });
  return { tables: present, joinPath, intent };
}

/**
 * Render a grounding block for a set of tables: columns + sample values, scoped metric
 * formulas, and the foreign keys among the tables as a *reference* (not a pre-built
 * join chain). FKs are offered for the model to pick the minimal set it needs.
 */
function renderGrounding(tables: string[], index: OntologyIndex, intent?: QueryIntent): string {
  const tset = new Set(tables);
  const parts: string[] = ['Tables:'];
  for (const t of tables) {
    const cols = index.columnsByTable.get(t);
    if (!cols) continue;
    const label = index.classes.get(t)?.prefLabel;
    const head = label && label.toLowerCase() !== t.toLowerCase() ? `${t} ("${label}")` : t;
    parts.push(`- ${head}: ${cols.map(renderColumn).join(', ')}`);
  }

  const metrics = index.capabilities.filter((c) => c.kind === 'metric' && tset.has(c.scopeTable));
  if (metrics.length > 0) {
    parts.push('', 'Metrics:');
    for (const m of metrics) {
      const formula = m.formulaHint ?? `(${m.scopeTable}.${m.scopeColumn ?? ''})`;
      const dir = m.preferredDirection ? ` [${m.preferredDirection} is better]` : '';
      // Provenance tier: a dry-run-validated metric is trustworthy; an LLM-inferred one is a guess.
      const trust = m.provenance === 'llm-validated' ? ' [validated]' : m.provenance === 'llm' ? ' [llm-inferred — verify]' : '';
      parts.push(`- "${m.prefLabel ?? m.scopeColumn ?? m.scopeTable}" = ${formula}${dir}${trust}`);
    }
  }

  // Foreign keys as a REFERENCE — join only the tables actually needed, never all of them.
  const edges = index.joinEdges.filter((e) => tset.has(e.fromTable) && tset.has(e.toTable));
  if (edges.length > 0) {
    parts.push(
      '',
      'Foreign keys (join ONLY the tables you need to answer — do NOT join a table whose columns you do not use;',
      'a one-to-many or many-to-many hop MULTIPLIES rows and corrupts aggregates, many-to-one / one-to-one are safe):',
    );
    for (const e of edges) {
      const extra = (e.extraColumns ?? []).map((x) => ` AND ${e.fromTable}.${x.from} = ${e.toTable}.${x.to}`).join('');
      parts.push(`- ${e.fromTable}.${e.fromColumn} = ${e.toTable}.${e.toColumn}${extra} (${e.cardinality})`);
    }
  }

  if (intent && intent.unresolved.length > 0) {
    parts.push(
      '',
      `Unresolved terms — resolve them against the schema above (they may be named entities held as data values): ${intent.unresolved.join(', ')}`,
    );
  }

  return parts.join('\n');
}

/** Full-ontology grounding (every table) — the baseline we measure reduction against. */
export function buildFullGrounding(index: OntologyIndex, intent?: QueryIntent): string {
  return renderGrounding([...index.columnsByTable.keys()], index, intent);
}

/**
 * Build the focused grounding for a question: the relevant slice + scoped knowledge,
 * plus token stats vs the full dump. Falls back to the full schema only if the linker
 * seeded nothing (better to over-include than starve the LLM).
 */
export function buildFocusedGrounding(question: string, index: OntologyIndex, opts: SliceOptions = {}): FocusedGrounding {
  const slice = selectRelevantSlice(question, index, opts);
  const haveSlice = slice.tables.length > 0;
  const grounding = haveSlice
    ? renderGrounding(slice.tables, index, slice.intent)
    : buildFullGrounding(index, slice.intent);

  const sliceTokens = estimateTokens(grounding);
  const fullTokens = estimateTokens(buildFullGrounding(index, slice.intent));
  const reductionPct = fullTokens > 0 ? Math.round((1 - sliceTokens / fullTokens) * 100) : 0;
  return { grounding, slice, stats: { sliceTokens, fullTokens, reductionPct } };
}
