/**
 * Stage-4 pipeline — wire the five query stages into one LangGraph flow.
 *
 *   S1 anchor → S2 subgraph → S3a planner → S3b compiler → execute
 *
 * This module is INTEGRATION only: it calls each stage's existing public entry
 * point and routes the two stages that can fail (S2 disconnected, S3a
 * repair-exhausted) to graceful terminal states carrying the partial trace —
 * never a throw, never the constrained-SQL fallback lane (a later brick).
 *
 * Two seams are load-bearing and live here, not in any stage:
 *  1. `deriveAnchoredColumns` (CRITICAL #1): turns the AnchorSet into the
 *     `anchoredColumns` map S2's trimmer needs, so a measure column like
 *     `driverstandings.points` — and its `temporalityEvidence` — survives the
 *     trim and S3b's cumulative-snapshot rewrite (H2) can fire.
 *  2. Failure routing: each fallible node writes a `failure` slice and a shared
 *     router sends it to END (CRITICAL #2).
 *
 * Collaborators (`llm`, `db`) are injected (mirrors the agent's node-factory deps
 * pattern) so this module imports no `eval/` code. The ontology `index`/`graph`/
 * `capabilities` are built ONCE from the fixture and passed into `runPipeline`.
 *
 * See docs/query/pipeline.md and docs/adr/006-pipeline-wiring.md.
 */
import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { classIri } from '../types/ontology.js';
import { anchorQuestion } from './anchor.js';
import type { AnchorIndex } from './anchor-index.js';
import type { AnchorSet, AnchorOpts, AnchorTrace, SuperlativeDirective } from './anchor-model.js';
import { extractSubgraph } from './subgraph.js';
import { groundSuperlatives } from './superlative.js';
import { pruneTerminals } from './prune.js';
import type { PruneTrace } from './prune.js';
import { rescueFkSymmetricSiblings } from './sibling-survival.js';
import type { SiblingSurvivalTrace } from './sibling-survival.js';
import type { OntologyGraph, SubgraphPayload, CapabilityRef, ExtractOpts } from './graph-model.js';
import { planQuery } from './planner.js';
import type { PlannerTrace } from './planner.js';
import { resolveGrain } from './grain-resolve.js';
import type { GrainResolveTrace } from './grain-resolve.js';
import type { MetricQueryIR } from './ir.js';
import { compile, CompileError } from './compiler.js';
import type { CompileTraceEntry } from './compiler.js';
import type { StructuredLlm } from '../llm/structured-llm.js';

// ── Public result / dependency types ───────────────────────────────────────

export interface PipelineFailure {
  stage: 'subgraph' | 'planner' | 'compiler' | 'execute';
  reason: string;
  detail?: string;
}

/** The provenance spine the Stage-5 certificate will later consume. */
export interface PipelineTraces {
  anchor?: AnchorTrace;
  prune?: PruneTrace;
  /** Stage-1.6 FK-symmetric grain-competitor sibling survival (absent when the trigger never fires). */
  siblingSurvival?: SiblingSurvivalTrace;
  subgraph?: { joins: SubgraphPayload['joins']; totalCost: number; disconnected?: boolean };
  /** Stage-1.x superlative groundings (empty/absent when no superlative fired). */
  superlative?: SuperlativeDirective[];
  planner?: PlannerTrace;
  /** Stage-3a.5 tier-1 grain resolver (ADR-016). `grainResolve.ambiguities` non-empty ⇒ grain-ambiguous. */
  grainResolve?: GrainResolveTrace;
  compiler?: CompileTraceEntry[];
}

/** A read-only DB handle (positional rows, column order preserved) — injected, never imported here. */
export interface ReadOnlyExecutor {
  query(sql: string): Promise<{ columns: string[]; rows: unknown[][] }>;
}

export interface PipelineDeps {
  index: AnchorIndex;
  graph: OntologyGraph;
  capabilities: CapabilityRef[];
  /** Planner LLM. Omit to use the real model; tests inject a deterministic fake. */
  llm?: StructuredLlm;
  /** Read-only executor. Omit to stop after compile (SQL-only path). */
  db?: ReadOnlyExecutor;
  anchorOpts?: AnchorOpts;
  plannerOpts?: { maxRetries?: number };
  extractOpts?: Omit<ExtractOpts, 'anchoredColumns'>;
}

export type PipelineResult =
  | {
      ok: true;
      sql: string;
      rows?: unknown[][];
      columns?: string[];
      anchorSet: AnchorSet;
      payload: SubgraphPayload;
      ir: MetricQueryIR;
      traces: PipelineTraces;
    }
  | {
      ok: false;
      failure: PipelineFailure;
      traces: PipelineTraces;
      anchorSet?: AnchorSet;
      payload?: SubgraphPayload;
      ir?: MetricQueryIR;
    };

// ── CRITICAL #1: anchoredColumns derivation ────────────────────────────────

/** Parse `qsl:property/<table>/<column>` → its table + column (last two `/`-segments). */
function parsePropertyIri(iri: string): { table: string; column: string } {
  const segs = iri.split('/');
  return { table: segs[segs.length - 2] ?? '', column: segs[segs.length - 1] ?? '' };
}

/**
 * Derive `anchoredColumns` (Map<classIri, columnName[]>) from an AnchorSet so S2's
 * `trimColumns` retains exactly the columns Stage-1 grounded:
 *  - each `valueAnchor` contributes its column (from `.property`) under its `.class`;
 *  - each `conceptAnchor` of `kind:'property'` contributes its column under the class
 *    derived from the property IRI's table;
 *  - `class`/`capability` concept anchors contribute no column directly.
 *
 * This is H2-load-bearing: without the measure column here, the trimmer drops it (and
 * its `temporalityEvidence`) and S3b silently emits a naive aggregate.
 */
export function deriveAnchoredColumns(set: AnchorSet): Map<string, string[]> {
  const byClass = new Map<string, Set<string>>();
  const add = (classI: string, column: string): void => {
    const s = byClass.get(classI) ?? new Set<string>();
    s.add(column);
    byClass.set(classI, s);
  };
  for (const v of set.valueAnchors) add(v.class, parsePropertyIri(v.property).column);
  for (const c of set.conceptAnchors) {
    if (c.kind !== 'property') continue;
    const { table, column } = parsePropertyIri(c.iri);
    add(classIri(table), column);
  }
  return new Map([...byClass].map(([k, s]) => [k, [...s]]));
}

// ── Pipeline state (mirrors src/agent/state.ts: Annotation.Root, last-write-wins) ──

const PipelineState = Annotation.Root({
  question: Annotation<string>(),
  anchorSet: Annotation<AnchorSet | null>({ reducer: (_p, n) => n, default: () => null }),
  payload: Annotation<SubgraphPayload | null>({ reducer: (_p, n) => n, default: () => null }),
  ir: Annotation<MetricQueryIR | null>({ reducer: (_p, n) => n, default: () => null }),
  sql: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
  rows: Annotation<unknown[][] | null>({ reducer: (_p, n) => n, default: () => null }),
  columns: Annotation<string[] | null>({ reducer: (_p, n) => n, default: () => null }),
  failure: Annotation<PipelineFailure | null>({ reducer: (_p, n) => n, default: () => null }),
  traces: Annotation<PipelineTraces>({ reducer: (p, n) => ({ ...p, ...n }), default: () => ({}) }),
});

type PipelineStateT = typeof PipelineState.State;
type Update = Partial<PipelineStateT>;

const ANCHOR = 'anchor';
const SUBGRAPH = 'subgraph';
const PLANNER = 'planner';
const RESOLVE = 'resolve';
const COMPILE = 'compile';
const EXECUTE = 'execute';

/** Conditional-edge router: any node that set `failure` ends the flow; otherwise continue. */
const routeOnFailure =
  <T extends string>(next: T) =>
  (state: PipelineStateT): T | typeof END =>
    state.failure ? END : next;

// ── Nodes ──────────────────────────────────────────────────────────────────

function anchorNode(deps: PipelineDeps) {
  return async function anchor(state: PipelineStateT): Promise<Update> {
    const anchorSet = anchorQuestion(state.question, deps.index, deps.anchorOpts ?? {});
    return { anchorSet, traces: { anchor: anchorSet.trace } };
  };
}

function subgraphNode(deps: PipelineDeps) {
  return async function subgraph(state: PipelineStateT): Promise<Update> {
    const set = state.anchorSet!;
    // S1.5 semantic pruning: drop recall-favoring terminals the question doesn't
    // SPECIFICALLY ground, BEFORE Steiner routes (the prune is over the terminal set
    // only — Steiner still traverses unanchored bridges). `deriveAnchoredColumns` stays
    // on the FULL set: pruned-away classes never enter the tree, so their columns are inert.
    const { terminals: prunedTerminals, trace: pruneTrace } = pruneTerminals(set);
    const anchoredColumns = deriveAnchoredColumns(set);
    // Stage-1.6 sibling survival: re-admit FK-symmetric grain-competitor siblings the prune dropped by
    // grain-blind specificity (ADR-014), so both reach the payload and Move 1's grain tag can choose.
    // Widens the must-include set only; back-prune (ADR-012) drops whichever sibling the plan omits.
    const sibling = rescueFkSymmetricSiblings({
      candidates: set.terminals,
      kept: prunedTerminals,
      anchoredColumns,
      graph: deps.graph,
    });
    const terminals = sibling.terminals;
    // Stage-1.x superlative grounding: a superlative over a single-orderable class adds that one
    // ranking column to the anchored set so the trimmer keeps it (the planner can then bind it).
    // Merge-only — the AnchorSet is untouched, so prune/Steiner/menu behaviour is unchanged.
    const superlatives = groundSuperlatives(state.question, terminals, deps.graph);
    for (const d of superlatives) {
      const cols = anchoredColumns.get(d.classIri) ?? [];
      if (!cols.includes(d.column)) cols.push(d.column);
      anchoredColumns.set(d.classIri, cols);
    }
    const payload = extractSubgraph(deps.graph, terminals, [], deps.capabilities, {
      ...deps.extractOpts,
      anchoredColumns,
    });
    const traces: PipelineTraces = {
      prune: pruneTrace,
      ...(sibling.trace.groups.length > 0 ? { siblingSurvival: sibling.trace } : {}),
      subgraph: { joins: payload.joins, totalCost: payload.totalCost, disconnected: payload.disconnected },
      ...(superlatives.length > 0 ? { superlative: superlatives } : {}),
    };
    if (payload.disconnected) {
      return { payload, failure: { stage: 'subgraph', reason: 'disconnected' }, traces };
    }
    return { payload, traces };
  };
}

function plannerNode(deps: PipelineDeps) {
  return async function planner(state: PipelineStateT): Promise<Update> {
    const res = await planQuery(state.question, state.payload!, {
      ...(deps.llm ? { llm: deps.llm } : {}),
      ...(deps.plannerOpts?.maxRetries !== undefined ? { maxRetries: deps.plannerOpts.maxRetries } : {}),
    });
    if (!res.ok) {
      return { failure: { stage: 'planner', reason: res.reason }, traces: { planner: res.trace } };
    }
    return { ir: res.ir, traces: { planner: res.trace } };
  };
}

function resolveNode(deps: PipelineDeps) {
  return async function resolve(state: PipelineStateT): Promise<Update> {
    // Tier-1 grain resolver (ADR-016): rebind the grain column to the operation-implied sibling where the
    // operation determines grain; surface (flag, never rewrite) the irreducible ASOF collision. Pure,
    // lexicon-free (no question string in scope), no LLM — back-prune then drops the unreferenced sibling.
    // The graph supplies FK-symmetry so a rebind stays within true grain siblings (never swaps entity).
    const { ir, trace } = resolveGrain(state.ir!, state.payload!, deps.graph);
    return { ir, traces: { grainResolve: trace } };
  };
}

function compileNode() {
  return async function compileN(state: PipelineStateT): Promise<Update> {
    try {
      const { sql, trace } = compile(state.ir!, state.payload!);
      return { sql, traces: { compiler: trace } };
    } catch (e) {
      if (e instanceof CompileError) {
        return { failure: { stage: 'compiler', reason: e.code, detail: e.message } };
      }
      throw e;
    }
  };
}

function executeNode(deps: PipelineDeps) {
  return async function execute(state: PipelineStateT): Promise<Update> {
    if (!deps.db) return {}; // SQL-only path — no executor injected.
    try {
      const { columns, rows } = await deps.db.query(state.sql!);
      return { columns, rows };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { failure: { stage: 'execute', reason: 'execute-error', detail } };
    }
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Compile the LangGraph for a fixed set of deps (collaborators closed over). */
export function buildPipeline(deps: PipelineDeps) {
  return new StateGraph(PipelineState)
    .addNode(ANCHOR, anchorNode(deps))
    .addNode(SUBGRAPH, subgraphNode(deps))
    .addNode(PLANNER, plannerNode(deps))
    .addNode(RESOLVE, resolveNode(deps))
    .addNode(COMPILE, compileNode())
    .addNode(EXECUTE, executeNode(deps))
    .addEdge(START, ANCHOR)
    .addEdge(ANCHOR, SUBGRAPH)
    .addConditionalEdges(SUBGRAPH, routeOnFailure(PLANNER), [PLANNER, END])
    // RESOLVE is pure and no-throw, so the planner routes straight into it and it always continues to COMPILE.
    .addConditionalEdges(PLANNER, routeOnFailure(RESOLVE), [RESOLVE, END])
    .addEdge(RESOLVE, COMPILE)
    .addConditionalEdges(COMPILE, routeOnFailure(EXECUTE), [EXECUTE, END])
    .addEdge(EXECUTE, END)
    .compile();
}

/**
 * Run a raw question through all five stages. `deps` carries the prebuilt ontology
 * index/graph/capabilities (built once) plus the injected llm/db collaborators.
 */
export async function runPipeline(question: string, deps: PipelineDeps): Promise<PipelineResult> {
  const final = (await buildPipeline(deps).invoke({ question })) as PipelineStateT;
  const traces = final.traces;

  if (final.failure) {
    return {
      ok: false,
      failure: final.failure,
      traces,
      ...(final.anchorSet ? { anchorSet: final.anchorSet } : {}),
      ...(final.payload ? { payload: final.payload } : {}),
      ...(final.ir ? { ir: final.ir } : {}),
    };
  }

  return {
    ok: true,
    sql: final.sql!,
    ...(final.rows ? { rows: final.rows } : {}),
    ...(final.columns ? { columns: final.columns } : {}),
    anchorSet: final.anchorSet!,
    payload: final.payload!,
    ir: final.ir!,
    traces,
  };
}
