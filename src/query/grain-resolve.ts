/**
 * Stage 3a.5 — the tier-1 operation⇒grain resolver (ADR-016). Sits between the planner (S3a) and the
 * compiler (S3b): it RESOLVES grain where the operation shape determines it, and SURFACES grain where
 * only question intent could (the irreducible 869/950 ASOF collision, proven in
 * docs/diagnosis/grain-separability.md).
 *
 * The three-brick chain completes here:
 *   survive both (ADR-014 sibling-survival) → tag both (ADR-013 menu + ADR-015 snapshot probe)
 *   → THIS resolver picks the operation-matching sibling → back-prune (ADR-012) drops the other leaf.
 *
 * LEXICON-FREE BY CONSTRUCTION. `resolveGrain(ir, payload)` does NOT receive the question string — the
 * operation shape is read ONLY from IR structure (`MetricQueryIR` fields) and payload structure
 * (`payload.joins` / `payload.classes`). It is therefore *impossible* for a lexical cue to leak in; H4
 * compliance is a structural guarantee, not a promise. No LLM, no DB. Pure and deterministic.
 *
 * PIN-FIRST, ASOF-WINS-TIES. The classifier checks the single-event pin BEFORE the resolvable shapes, so
 * any whiff of a pin routes to ASOF → SURFACE (flag, never rewrite). The asymmetry is deliberate: a
 * wrongly-flagged ambiguity costs a flag; a wrongly-RESOLVED one costs a silent wrong answer. When in
 * doubt, flag.
 */
import type { MetricQueryIR, Measure } from './ir.js';
import type { OntologyGraph, SubgraphPayload } from './graph-model.js';
import { tableOfClassIri } from './graph-build.js';
import { classIri, datatypePropertyIri } from '../types/ontology.js';
import { fkSymmetric } from './sibling-survival.js';

// ── Grain vocabulary ────────────────────────────────────────────────────────

/** The binary the operation actually distinguishes: a per-event value vs THE standing (a state). */
export type ImpliedGrain = 'per-event' | 'standings';

/** A column's grain, mapped from its `qsl:temporality` tag (absent ⇒ per-event). */
export type ColumnGrain = 'per-event' | 'cumulative' | 'snapshot';

function grainOfTemporality(temporality: string | undefined): ColumnGrain {
  if (temporality === 'cumulative-snapshot') return 'cumulative';
  if (temporality === 'as-of-event-snapshot') return 'snapshot';
  return 'per-event'; // untagged
}

const isStandings = (g: ColumnGrain): boolean => g !== 'per-event';

// ── Operation shape (derived from IR + payload structure only) ────────────────

export type OperationShape =
  | 'ASOF_EVENT_FILTER' // single-event pin → COLLISION → surface (869 per-event vs 950 cumulative)
  | 'MAX_OR_LATEST_UNPINNED' // unpinned superlative/extreme over the grain column → standings
  | 'AGG_OVER_EVENTS' // SUM/AVG/COUNT of the grain column across events → per-event
  | 'PER_ROW_SELECT' // bare projection, no aggregate, no pin → unconstrained (no-op)
  | 'NONE'; // the grain column is not referenced by this IR

const AGG_FNS = new Set(['SUM', 'AVG', 'COUNT']);
const EXTREME_FNS = new Set(['MAX', 'MIN']);

// ── Trace ─────────────────────────────────────────────────────────────────

export interface GrainResolution {
  /** The grain-competitor column name (e.g. `points`). */
  column: string;
  /** The table the planner bound (e.g. `constructorstandings`). */
  from: string;
  /** The table the resolver bound instead (e.g. `constructorresults`). */
  to: string;
  shape: 'AGG_OVER_EVENTS' | 'MAX_OR_LATEST_UNPINNED';
  impliedGrain: ImpliedGrain;
}

export interface GrainAmbiguity {
  column: string;
  shape: 'ASOF_EVENT_FILTER';
  /** The competing grain-competitor siblings present in the payload (sorted by table). */
  candidates: { table: string; grain: ColumnGrain }[];
  /** Why this is irreducible (structural — no lexical cue read). */
  note: string;
}

export interface GrainResolveTrace {
  /** Deterministic grain rebinds (separable shapes). Empty ⇒ nothing rewritten. */
  resolutions: GrainResolution[];
  /** Irreducible (intent-dependent) cases SURFACED, never resolved. `grainAmbiguous` ⇔ non-empty. */
  ambiguities: GrainAmbiguity[];
}

// ── IRI parsing (mirrors compiler.ts / pipeline.ts: last two `/`-segments) ────

function parseIri(iri: string): { table: string; column: string } {
  const parts = iri.split('/');
  return { table: parts[parts.length - 2] ?? '', column: parts[parts.length - 1] ?? '' };
}

// ── Grain-competitor groups (the trigger) ─────────────────────────────────────

interface Member {
  table: string;
  classIri: string;
  grain: ColumnGrain;
}

/** Payload classes carrying column `col`, as resolver Members. */
function carriersOf(payload: SubgraphPayload, col: string): Member[] {
  const out: Member[] = [];
  for (const c of payload.classes) {
    const p = c.properties.find((q) => q.col === col);
    if (!p) continue;
    out.push({ table: tableOfClassIri(c.iri), classIri: c.iri, grain: grainOfTemporality(p.temporality) });
  }
  return out;
}

/**
 * The FK-symmetric grain-competitor sibling component for `col` that CONTAINS `anchorClassIri` (the
 * planner's binding). Two carriers are siblings iff `fkSymmetric` (ADR-014): identical declared-neighbour
 * signature after removing each other — the SAME structural test sibling-survival used to keep both. This
 * is load-bearing: it confines a grain rebind to a true grain sibling (`constructorresults`↔
 * `constructorstandings`, both → `constructors`) and NEVER swaps the entity (a `points` column also exists
 * on `driverstandings`, but it is not FK-symmetric to either constructor table, so it is never a target).
 *
 * A column is a grain competitor for the binding only if its component has ≥2 members of DIFFERING grain.
 */
function siblingComponent(graph: OntologyGraph, payload: SubgraphPayload, anchorClassIri: string, col: string): Member[] {
  const carriers = carriersOf(payload, col);
  if (!carriers.some((m) => m.classIri === anchorClassIri)) return [];
  const inComponent = new Set<string>([anchorClassIri]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of carriers) {
      if (inComponent.has(m.classIri)) continue;
      if ([...inComponent].some((ci) => fkSymmetric(graph, ci, m.classIri))) {
        inComponent.add(m.classIri);
        changed = true;
      }
    }
  }
  return carriers.filter((m) => inComponent.has(m.classIri));
}

/**
 * Column NAMES that pin a single event/row when equality-filtered to a constant. Two structural sources:
 *  - **join-key columns** (any `payload.joins[].on` pair) — the event/entity foreign keys (`raceid`,
 *    `constructorid`). Matched by NAME, not `table.col`: which copy of an FK the Steiner tree materializes
 *    (e.g. `races` reached via `qualifying.raceid` rather than the fact's own `raceid`) must not change
 *    whether a `raceId = const` filter is a pin.
 *  - **grain-evidence calendar columns** — the `orderColumn` + `partitionColumns` named in any column's
 *    `qsl:temporalityEvidence` (e.g. `round`, `year`). The planner often expresses an event pin as a
 *    CALENDAR equality (`races.round = 9`, case 869) rather than the FK (`raceId = 9`, case 950); both
 *    pin a single event. This is what makes 869 classify as ASOF (surface) instead of MAX (resolve).
 *
 * Grain columns (`points`/`position`) are never join keys nor evidence columns, so a value filter on the
 * grain column (`points = 0`) is never mistaken for a pin. A non-calendar value filter (`races.name =
 * 'Monaco'`, case 994) is in neither set, so an aggregate over many such events stays AGG_OVER_EVENTS.
 */
function singleEventPinColumns(payload: SubgraphPayload): Set<string> {
  const cols = new Set<string>();
  for (const j of payload.joins) {
    for (const [a, b] of j.on) {
      cols.add(a);
      cols.add(b);
    }
  }
  for (const c of payload.classes) {
    for (const p of c.properties) {
      const ev = p.temporalityEvidence;
      if (!ev) continue;
      for (const pc of ev.partitionColumns) cols.add(pc);
      cols.add(ev.orderColumn);
    }
  }
  return cols;
}

// ── IR slot enumeration (every place a property IRI can appear) ───────────────

/** Every property IRI the IR references, across all slots. */
function allReferencedIris(ir: MetricQueryIR): string[] {
  const out: string[] = [];
  for (const s of ir.select ?? []) out.push(s.property);
  for (const g of ir.groupBy ?? []) out.push(g.property);
  for (const f of ir.filters ?? []) out.push(f.property);
  for (const o of ir.orderBy ?? []) if (o.byProperty) out.push(o.byProperty);
  for (const m of ir.measures ?? []) if (m.aggExpr) out.push(m.aggExpr.property);
  return out;
}

/** Tables the IR binds column `col` to (any slot). Usually one; >1 ⇒ a pre-split the planner shouldn't emit. */
function bindingTablesForColumn(ir: MetricQueryIR, col: string): string[] {
  const tables = new Set<string>();
  for (const iri of allReferencedIris(ir)) {
    const p = parseIri(iri);
    if (p.column === col) tables.add(p.table);
  }
  return [...tables];
}

/** Measure aliases whose aggExpr is over column `col` — so ORDER BY byAlias can be tied back to the grain column. */
function measureAliasesOverColumn(ir: MetricQueryIR, col: string): Set<string> {
  const out = new Set<string>();
  (ir.measures ?? []).forEach((m, i) => {
    if (!m.aggExpr) return;
    if (parseIri(m.aggExpr.property).column !== col) return;
    out.add(m.alias ?? `${m.aggExpr.fn.toLowerCase()}_${parseIri(m.aggExpr.property).column}`);
    void i;
  });
  return out;
}

/** Does any orderBy target the grain column (directly, or via a measure alias over it)? */
function orderByTargetsColumn(ir: MetricQueryIR, col: string): boolean {
  const aliases = measureAliasesOverColumn(ir, col);
  return (ir.orderBy ?? []).some((o) => {
    if (o.byProperty) return parseIri(o.byProperty).column === col;
    if (o.byAlias) return aliases.has(o.byAlias);
    return false;
  });
}

// ── Single-event pin (structural) ─────────────────────────────────────────────

/**
 * A single-event pin pins the grain column to ONE specific event/row. Two structural forms:
 *  (a) an equality filter to a constant on a JOIN-KEY column (excluding the grain column itself) —
 *      e.g. `raceId = 291` / `raceId = 9`. `points = 0` is NOT a pin: `points` is the grain column, not
 *      a join key.
 *  (b) `orderBy` + `limit === 1` selecting one row by an ordering that is NOT the grain column — the row
 *      is chosen by some other key and the grain column is read as-of it (e.g. `ORDER BY year ASC LIMIT 1`).
 */
function hasSingleEventPin(ir: MetricQueryIR, col: string, pinColumns: Set<string>): boolean {
  // (a) equality filter on a join-key or calendar/grain-evidence column
  for (const f of ir.filters ?? []) {
    if (f.op !== '=' || Array.isArray(f.value)) continue;
    const { column } = parseIri(f.property);
    if (column === col) continue; // a value filter on the grain column is not an event pin
    if (pinColumns.has(column)) return true;
  }
  // (b) order-then-limit-1 by a non-grain ordering
  if (ir.limit === 1 && (ir.orderBy?.length ?? 0) > 0 && !orderByTargetsColumn(ir, col)) {
    return true;
  }
  return false;
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify the operation shape over grain-competitor column `col` from IR + payload STRUCTURE alone.
 * Pin-first: any single-event pin → ASOF (surface), so we never wrongly rewrite a pinned case.
 */
export function classifyOperationShape(ir: MetricQueryIR, col: string, payload: SubgraphPayload): OperationShape {
  if (bindingTablesForColumn(ir, col).length === 0) return 'NONE';

  if (hasSingleEventPin(ir, col, singleEventPinColumns(payload))) return 'ASOF_EVENT_FILTER';

  for (const m of ir.measures ?? []) {
    if (m.aggExpr && parseIri(m.aggExpr.property).column === col && EXTREME_FNS.has(m.aggExpr.fn)) {
      return 'MAX_OR_LATEST_UNPINNED';
    }
  }
  if (orderByTargetsColumn(ir, col)) return 'MAX_OR_LATEST_UNPINNED';

  for (const m of ir.measures ?? []) {
    if (m.aggExpr && parseIri(m.aggExpr.property).column === col && AGG_FNS.has(m.aggExpr.fn)) {
      return 'AGG_OVER_EVENTS';
    }
  }

  if ((ir.select ?? []).some((s) => parseIri(s.property).column === col)) return 'PER_ROW_SELECT';
  return 'NONE';
}

// ── IR rewrite (retarget a grain column from one table to its sibling) ─────────

function retargetIri(iri: string, col: string, fromTable: string, toTable: string): string {
  const p = parseIri(iri);
  if (p.column === col && p.table === fromTable) return datatypePropertyIri(toTable, col);
  return iri;
}

/** Produce a new IR with every slot referencing `col` on `fromTable` rebound to `toTable`. */
function rewriteColumnTable(ir: MetricQueryIR, col: string, fromTable: string, toTable: string): MetricQueryIR {
  const r = (iri: string): string => retargetIri(iri, col, fromTable, toTable);
  const next: MetricQueryIR = { ...ir };
  if (ir.select) next.select = ir.select.map((s) => ({ ...s, property: r(s.property) }));
  if (ir.groupBy) next.groupBy = ir.groupBy.map((g) => ({ ...g, property: r(g.property) }));
  if (ir.filters) next.filters = ir.filters.map((f) => ({ ...f, property: r(f.property) }));
  if (ir.orderBy)
    next.orderBy = ir.orderBy.map((o) => (o.byProperty ? { ...o, byProperty: r(o.byProperty) } : { ...o }));
  if (ir.measures)
    next.measures = ir.measures.map((m): Measure =>
      m.aggExpr ? { ...m, aggExpr: { ...m.aggExpr, property: r(m.aggExpr.property) } } : { ...m },
    );
  return next;
}

// ── The resolver ──────────────────────────────────────────────────────────────

/**
 * Resolve grain where the operation determines it; surface it where only intent could.
 *
 * For each grain-competitor column the IR references:
 *  - ASOF_EVENT_FILTER → SURFACE: record `grainAmbiguous`, keep the planner's binding (no rewrite).
 *  - AGG_OVER_EVENTS  → implied per-event: if the planner bound the wrong grain, rebind to the (unique)
 *                       per-event sibling.
 *  - MAX_OR_LATEST    → implied standings: if the planner bound the wrong grain, rebind to the (unique)
 *                       tagged sibling.
 *  - PER_ROW_SELECT / NONE → no-op.
 *
 * Defensive: when the rebind target is not UNIQUE (≥2 candidate siblings of the implied grain), the pick
 * is itself ambiguous → surface rather than guess. So the binary per-event-vs-standings simplification
 * degrades to honesty, not a coin-flip, on a DB where a group carries ≥2 distinct non-per-event tags.
 */
export function resolveGrain(
  ir: MetricQueryIR,
  payload: SubgraphPayload,
  graph: OntologyGraph,
): { ir: MetricQueryIR; trace: GrainResolveTrace } {
  const resolutions: GrainResolution[] = [];
  const ambiguities: GrainAmbiguity[] = [];
  let current = ir;

  const candidatesOf = (members: Member[]): { table: string; grain: ColumnGrain }[] =>
    [...members].sort((a, b) => (a.table < b.table ? -1 : 1)).map((m) => ({ table: m.table, grain: m.grain }));

  // Distinct columns the IR references, in stable first-seen order.
  const columns = [...new Set(allReferencedIris(current).map((iri) => parseIri(iri).column))];

  for (const col of columns) {
    // The planner's binding table(s) for this column. A pre-split (>1 distinct table) is not something
    // the planner emits; treat it conservatively as ambiguous rather than rewriting half of it.
    const boundTables = bindingTablesForColumn(current, col);
    if (boundTables.length === 0) continue;

    // Restrict to the FK-symmetric sibling component of the binding — never swap entity (ADR-014/016).
    const anchorTable = boundTables[0]!;
    const members = siblingComponent(graph, payload, classIri(anchorTable), col);
    if (members.length < 2) continue; // no grain sibling for this binding
    if (new Set(members.map((m) => m.grain)).size < 2) continue; // all same grain ⇒ not a competitor

    const shape = classifyOperationShape(current, col, payload);

    if (shape === 'ASOF_EVENT_FILTER') {
      ambiguities.push({
        column: col,
        shape,
        candidates: candidatesOf(members),
        note: `single-event pin: grain is intent-dependent (per-event "scored at the event" vs standings "as of the event") — not resolvable from structure`,
      });
      continue;
    }

    if (shape !== 'AGG_OVER_EVENTS' && shape !== 'MAX_OR_LATEST_UNPINNED') continue; // PER_ROW_SELECT / NONE

    const impliedGrain: ImpliedGrain = shape === 'AGG_OVER_EVENTS' ? 'per-event' : 'standings';

    if (boundTables.length !== 1) {
      // Pre-split binding — cannot safely rewrite a subset; surface instead of guessing.
      ambiguities.push({
        column: col,
        shape: 'ASOF_EVENT_FILTER',
        candidates: candidatesOf(members),
        note: `column bound to multiple tables in the IR (${boundTables.join(', ')}) — cannot resolve a subset`,
      });
      continue;
    }
    const fromTable = boundTables[0]!;
    const currentGrain = members.find((m) => m.table === fromTable)?.grain ?? 'per-event';

    const grainMatches = impliedGrain === 'per-event' ? currentGrain === 'per-event' : isStandings(currentGrain);
    if (grainMatches) continue; // planner already bound the implied grain — no-op (don't churn the IR)

    // The rebind target: members whose grain satisfies the implied grain, other than the current binding.
    const targets = members.filter(
      (m) =>
        m.table !== fromTable &&
        (impliedGrain === 'per-event' ? m.grain === 'per-event' : isStandings(m.grain)),
    );
    if (targets.length !== 1) {
      // No unique sibling of the implied grain (0 ⇒ none to move to; ≥2 ⇒ ambiguous) → surface.
      if (targets.length >= 2) {
        ambiguities.push({
          column: col,
          shape: 'ASOF_EVENT_FILTER',
          candidates: candidatesOf(members),
          note: `${shape} implies ${impliedGrain} grain but ≥2 candidate siblings carry it — cannot pick deterministically`,
        });
      }
      continue;
    }

    const toTable = targets[0]!.table;
    current = rewriteColumnTable(current, col, fromTable, toTable);
    resolutions.push({ column: col, from: fromTable, to: toTable, shape, impliedGrain });
  }

  return { ir: current, trace: { resolutions, ambiguities } };
}
