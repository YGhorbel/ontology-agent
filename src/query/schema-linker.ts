/**
 * Schema linker (pure, tier-1 deterministic).
 *
 * Resolves a natural-language question into a typed `QueryIntent` over the ontology —
 * a RESDSQL-style skeleton (projection, measures, group-by, filters, order, limit)
 * whose slots are filled with linked columns/values. `QueryIntent.tables` feeds the
 * join resolver — schema linking and joinpath meet at one `string[]`.
 *
 * Channels, in priority order (each claims tokens greedily, longest span first):
 *   1. alias channel — phrases from a parsed evidence string (LinkHints) bind directly
 *   2. value channel — question literal ∈ a column's value dictionary (text only)
 *   3. name channel  — span vs an element's prefLabel ∪ altLabel ∪ name ∪ comment
 *   4. numeric adjacency — a bare integer binds as a filter on the column named beside it
 *
 * Ambiguity (a span matching >1 distinct element) is *surfaced* in `ambiguities`, the
 * top-scored candidate still chosen so the intent stays usable — no LLM.
 */
import type { OntologyIndex } from './ontology-index.js';
import type { ElementRef, LinkCandidate, LinkHints, LinkRole, QueryIntent } from '../types/query-intent.js';
import { buildLinkTargets, type LinkTarget } from './link-surface.js';
import {
  normalize,
  rawTokens,
  singularize,
  similarity,
  isCue,
  isProjectionCue,
  isSuperlative,
  directionFor,
  parseNumberWord,
  isNumericLiteral,
  tokenize,
} from './text-normalize.js';

/** Minimum name-channel score to consider a candidate at all. */
const FLOOR = 0.6;
/** Single-token fuzzy (typo) acceptance threshold. */
const FUZZY_MIN = 0.82;
/** Score band below the top within which competing refs count as ambiguous. */
const AMBIG_DELTA = 0.05;
/** Confidence assigned to a value-dictionary (content) match. */
const VALUE_SCORE = 0.95;
/** Cap for a low-weight rdfs:comment containment match (multi-word spans only). */
const COMMENT_SCORE = 0.72;
/** Minimum alias-token coverage for a question span to trigger an alias. */
const ALIAS_COV = 0.6;

export interface LinkOptions {
  /** Deterministically-parsed evidence (aliases, value illustrations, order/limit). */
  hints?: LinkHints;
}

interface PositionedSpan {
  text: string;
  toks: string[];
  start: number;
  len: number;
}

interface Accepted {
  cand: LinkCandidate;
  target: LinkTarget | null;
  start: number;
  len: number;
}

const refKey = (ref: { table: string; column?: string }): string => `${ref.table}.${ref.column ?? ''}`;
const roleRank = (r: LinkRole): number => (r === 'measure' ? 3 : r === 'dimension' ? 2 : r === 'entity' ? 1 : 0);

/** A lone token that is a framing/aggregation/ordinal word — never a schema reference on its own. */
const skippable = (t: string): boolean =>
  isCue(t) || isProjectionCue(t) || isSuperlative(t) || t === 'first' || t === 'last';

/** Positioned 1..n-gram spans, longest first then left-to-right (for greedy matching). */
function positionedSpans(toks: string[], n = 3): PositionedSpan[] {
  const out: PositionedSpan[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    for (let len = 1; len <= n && i + len <= toks.length; len += 1) {
      out.push({ text: toks.slice(i, i + len).join(' '), toks: toks.slice(i, i + len), start: i, len });
    }
  }
  out.sort((a, b) => b.len - a.len || a.start - b.start);
  return out;
}

/** Best name-channel score of a span against one target's surfaces (+ bounded comment), in [0,1]. */
function nameScore(spanText: string, spanToks: string[], t: LinkTarget): number {
  let best = 0;
  for (let i = 0; i < t.surfaces.length; i += 1) {
    const surf = t.surfaces[i] as string;
    const stoks = t.surfaceTokens[i] as string[];
    if (spanText === surf) return 1;
    const subset = spanToks.length < stoks.length && spanToks.every((x) => stoks.includes(x));
    if (subset) {
      best = Math.max(best, 0.76 + 0.13 * (spanToks.length / stoks.length));
    } else if (spanText.length >= 4 && surf.includes(spanText)) {
      best = Math.max(best, 0.8);
    } else if (spanToks.length === 1 && stoks.length === 1) {
      const sim = similarity(spanText, surf);
      if (sim >= FUZZY_MIN) best = Math.max(best, Math.min(0.9, sim));
    }
  }
  // Low-weight comment surface: only multi-word spans whose tokens are all in the comment.
  if (best === 0 && spanToks.length >= 2 && t.commentTokens.length > 0 && spanToks.every((x) => t.commentTokens.includes(x))) {
    best = COMMENT_SCORE;
  }
  return best;
}

const toCandidate = (ref: ElementRef, kind: LinkCandidate['kind'], role: LinkRole, score: number, via: 'name' | 'value', matchedValue?: string): LinkCandidate => ({
  ref,
  kind,
  role,
  score,
  via,
  ...(matchedValue !== undefined ? { matchedValue } : {}),
});

export function linkQuestion(question: string, index: OntologyIndex, opts: LinkOptions = {}): QueryIntent {
  const hints = opts.hints;
  const targets = buildLinkTargets(index);
  const targetByRef = new Map<string, LinkTarget>();
  for (const t of targets) if (!targetByRef.has(refKey(t.ref))) targetByRef.set(refKey(t.ref), t);

  const raw = rawTokens(question); // not singularized — used for value matching
  const nameToks = raw.map(singularize); // singularized — used for name matching
  const grouping = raw.some((t) => t === 'by' || t === 'per' || t === 'each' || t === 'group' || t === 'grouped');
  // Projection cues (list/show/give/name/…) double as stopwords, so check the
  // pre-stopword question rather than `raw`.
  const wantsProjection = normalize(question).split(' ').some((t) => isProjectionCue(t));
  // Ranking context: a superlative with no grouping cue ⇒ rank rows by a metric
  // (ORDER BY + LIMIT), not aggregate it (GROUP BY + measure).
  const supIdx = raw.findIndex((t) => isSuperlative(singularize(t)));
  const supTok = supIdx >= 0 ? singularize(raw[supIdx] as string) : null;
  const rankingContext = !grouping && supIdx >= 0;
  // Foreign-key columns (the `from` side of each join edge) must never surface as a
  // projection or group-by column — they are join plumbing, not user-facing data.
  const fkCols = new Set(index.joinEdges.map((e) => `${e.fromTable}.${e.fromColumn}`));
  // A metric's declared ranking polarity (ontology data) — drives sort direction for
  // "best/worst/fastest/slowest" without any hardcoded domain keywords.
  const prefDirOf = (table: string, column: string): 'higher' | 'lower' | undefined =>
    index.capabilities.find((c) => c.kind === 'metric' && c.scopeTable === table && c.scopeColumn === column)?.preferredDirection;

  const covered = new Array<boolean>(nameToks.length).fill(false);
  const refAt = new Array<Accepted | null>(nameToks.length).fill(null);
  const accepted: Accepted[] = [];
  const ambiguities: QueryIntent['ambiguities'] = [];

  const overlaps = (start: number, len: number): boolean => {
    for (let p = start; p < start + len; p += 1) if (covered[p]) return true;
    return false;
  };
  const accept = (a: Accepted): void => {
    accepted.push(a);
    for (let p = a.start; p < a.start + a.len; p += 1) {
      covered[p] = true;
      refAt[p] = a;
    }
  };

  // --- 1. Alias channel (evidence) — highest priority ---
  const aliasEntries = (hints?.aliases ?? []).map((a) => ({ toks: tokenize(a.phrase), ref: a.ref }));
  if (aliasEntries.length > 0) {
    for (const sp of positionedSpans(nameToks)) {
      if (overlaps(sp.start, sp.len)) continue;
      let hit: ElementRef | null = null;
      for (const a of aliasEntries) {
        if (a.toks.length === 0) continue;
        const subset = sp.toks.every((x) => a.toks.includes(x));
        const cov = sp.toks.filter((x) => a.toks.includes(x)).length / a.toks.length;
        if (subset && cov >= ALIAS_COV) { hit = a.ref; break; }
      }
      if (!hit) continue;
      const tgt = targetByRef.get(refKey(hit)) ?? null;
      const role: LinkRole = tgt?.role ?? 'attribute';
      const kind: LinkCandidate['kind'] = hit.column ? 'column' : 'class';
      accept({ cand: toCandidate(hit, kind, role, 1, 'name'), target: tgt, start: sp.start, len: sp.len });
    }
  }

  // --- 2. Value channel (text literals only; numerics handled by adjacency) ---
  for (const sp of positionedSpans(raw, 2)) {
    if (overlaps(sp.start, sp.len)) continue;
    if (sp.toks.some((t) => isNumericLiteral(t))) continue; // never value-dict match numbers
    const matches = targets.filter((t) => t.kind === 'column' && t.sampleValues.includes(sp.text));
    if (matches.length === 0) continue;
    const byRef = new Map<string, LinkTarget>();
    for (const m of matches) if (!byRef.has(refKey(m.ref))) byRef.set(refKey(m.ref), m);
    const distinct = [...byRef.values()];
    if (distinct.length >= 2) {
      ambiguities.push({ span: sp.text, candidates: distinct.map((t) => toCandidate(t.ref, t.kind, t.role, VALUE_SCORE, 'value', sp.text)) });
    }
    const t = distinct[0] as LinkTarget;
    accept({ cand: toCandidate(t.ref, t.kind, t.role, VALUE_SCORE, 'value', sp.text), target: t, start: sp.start, len: sp.len });
  }

  // --- 3. Name channel (greedy longest-first) over what's left ---
  for (const sp of positionedSpans(nameToks)) {
    if (overlaps(sp.start, sp.len)) continue;
    if (sp.toks.every((t) => skippable(t))) continue; // lone framing/ordinal words don't link
    const scored: Array<{ t: LinkTarget; score: number }> = [];
    for (const t of targets) {
      const s = nameScore(sp.text, sp.toks, t);
      if (s >= FLOOR) scored.push({ t, score: s });
    }
    if (scored.length === 0) continue;

    const byRef = new Map<string, { t: LinkTarget; score: number }>();
    for (const s of scored) {
      const rk = refKey(s.t.ref);
      const prev = byRef.get(rk);
      if (!prev || s.score > prev.score || (s.score === prev.score && roleRank(s.t.role) > roleRank(prev.t.role))) {
        byRef.set(rk, s);
      }
    }
    const distinct = [...byRef.values()].sort((a, b) => b.score - a.score);
    const chosen = distinct[0] as { t: LinkTarget; score: number };

    const contenders = distinct.filter((d) => d.score >= chosen.score - AMBIG_DELTA);
    if (contenders.length >= 2 && chosen.score >= 0.9) {
      ambiguities.push({ span: sp.text, candidates: contenders.map((d) => toCandidate(d.t.ref, d.t.kind, d.t.role, d.score, 'name')) });
    }
    accept({ cand: toCandidate(chosen.t.ref, chosen.t.kind, chosen.t.role, chosen.score, 'name'), target: chosen.t, start: sp.start, len: sp.len });
  }

  // --- 4. Numeric-literal adjacency: bind a bare integer to the column named beside it ---
  const numericFilters: Array<{ table: string; column: string; value: string }> = [];
  const pkOf = (table: string): string | undefined => index.columnsByTable.get(table)?.find((c) => c.isPrimaryKey)?.column;
  for (let q = 0; q < raw.length; q += 1) {
    if (covered[q] || !isNumericLiteral(raw[q] as string)) continue;
    const neighbour = refAt[q - 1] ?? refAt[q - 2] ?? null;
    if (!neighbour) continue;
    const ref = neighbour.cand.ref;
    const column = ref.column ?? pkOf(ref.table);
    if (!column) continue;
    numericFilters.push({ table: ref.table, column, value: raw[q] as string });
    covered[q] = true;
  }

  // --- Assemble the typed intent ---
  const tables = new Set<string>();
  const measureKeys = new Set<string>();
  const measures: QueryIntent['measures'] = [];
  const dimKeys = new Set<string>();
  const groupDims: QueryIntent['groupDims'] = [];
  // In ranking context a metric is the ORDER BY target, not an aggregate; collect
  // candidates here (with a label for metric-aware direction) instead of `measures`.
  const rankCandidates: Array<{ table: string; column: string; preferredDirection?: 'higher' | 'lower' }> = [];
  const filterByCol = new Map<string, { table: string; column: string; values: string[]; matchedSample: boolean }>();
  const filterRefs = new Set<string>();

  const addFilter = (table: string, column: string, value: string, matchedSample: boolean): void => {
    const k = `${table}.${column}`;
    const f = filterByCol.get(k) ?? { table, column, values: [], matchedSample };
    if (!f.values.includes(value)) f.values.push(value);
    f.matchedSample = f.matchedSample && matchedSample;
    filterByCol.set(k, f);
    filterRefs.add(k);
  };

  for (const { cand, target } of accepted) {
    tables.add(cand.ref.table);
    const col = cand.ref.column;
    if (cand.via === 'value' && col) {
      addFilter(cand.ref.table, col, cand.matchedValue ?? '', true);
    } else if (cand.role === 'measure' && col) {
      const k = `${cand.ref.table}.${col}`;
      if (rankingContext) {
        // Rank by this metric (ORDER BY), don't aggregate it (no GROUP BY / measure).
        if (!rankCandidates.some((r) => r.table === cand.ref.table && r.column === col)) {
          const pd = prefDirOf(cand.ref.table, col);
          rankCandidates.push({ table: cand.ref.table, column: col, ...(pd ? { preferredDirection: pd } : {}) });
        }
      } else if (!measureKeys.has(k)) {
        measureKeys.add(k);
        measures.push({ table: cand.ref.table, column: col, ...(target?.capability ? { capability: target.capability } : {}) });
      }
    } else if (cand.kind === 'column' && col && (grouping || cand.role === 'dimension')) {
      const k = `${cand.ref.table}.${col}`;
      if (!dimKeys.has(k) && !fkCols.has(k)) {
        dimKeys.add(k);
        groupDims.push({ table: cand.ref.table, column: col });
      }
    }
  }
  for (const nf of numericFilters) {
    tables.add(nf.table);
    addFilter(nf.table, nf.column, nf.value, false);
  }
  // Value illustrations from evidence are filters too.
  for (const v of hints?.values ?? []) {
    tables.add(v.ref.table);
    if (v.ref.column) addFilter(v.ref.table, v.ref.column, v.value, false);
  }

  const filters: QueryIntent['filters'] = [...filterByCol.values()].map((f) => ({
    table: f.table,
    column: f.column,
    op: f.values.length > 1 ? 'in' : '=',
    value: f.values.join(', '),
    matchedSample: f.matchedSample,
  }));
  // GROUP BY is only meaningful alongside an aggregate; and a column used as a filter
  // is not also a group dimension (e.g. an aliased id bound to a literal).
  const groupDimsOut = measures.length === 0
    ? []
    : groupDims.filter((g) => !filterRefs.has(`${g.table}.${g.column}`));

  // Order + limit: evidence hints first, else a light superlative/number cue grammar.
  const orderBy: QueryIntent['orderBy'] = [];
  let limit: number | null = null;
  const resolveOrderTable = (column: string): string | undefined => {
    const inLinked = [...tables].find((t) => index.columnsByTable.get(t)?.some((c) => c.column === column));
    if (inLinked) return inLinked;
    for (const [t, cols] of index.columnsByTable) if (cols.some((c) => c.column === column)) return t;
    return undefined;
  };
  if (hints?.orderBy?.length) {
    for (const o of hints.orderBy) {
      const t = resolveOrderTable(o.column);
      if (t) { orderBy.push({ table: t, column: o.column, dir: o.dir }); tables.add(t); }
    }
  }
  if (hints?.limit != null) limit = hints.limit;
  if (orderBy.length === 0 || limit == null) {
    // Cue grammar: a superlative implies a direction; a nearby number implies a limit.
    if (supTok) {
      // Rank by the ranking-context metric if there is one, else by an aggregate;
      // direction is metric-aware for polarity-ambiguous words (fastest/slowest).
      const rank = rankCandidates[0]
        ?? (measures[0]
          ? { table: measures[0].table, column: measures[0].column, preferredDirection: prefDirOf(measures[0].table, measures[0].column) }
          : null);
      if (orderBy.length === 0 && rank) {
        orderBy.push({ table: rank.table, column: rank.column, dir: directionFor(supTok, { preferredDirection: rank.preferredDirection }) });
        tables.add(rank.table);
      }
      if (limit == null) {
        const numTok = raw.map((t) => parseNumberWord(t)).find((n): n is number => n !== null);
        if (numTok != null && !numericFilters.some((f) => f.value === String(numTok))) limit = numTok;
      }
      // A singular superlative subject ("the fastest driver") returns exactly one row.
      if (limit == null) limit = 1;
    }
  }

  // Projection: plain attribute columns matched by name when a projection cue is present,
  // excluding keys and anything already used as a filter / measure / group-by / order-by.
  const isPk = (table: string, column: string): boolean =>
    Boolean(index.columnsByTable.get(table)?.find((c) => c.column === column)?.isPrimaryKey);
  const orderByKeys = new Set(orderBy.map((o) => `${o.table}.${o.column}`));
  const projection: QueryIntent['projection'] = [];
  const projKeys = new Set<string>();
  if (wantsProjection) {
    for (const { cand } of accepted) {
      const col = cand.ref.column;
      if (!col || cand.kind !== 'column' || cand.via !== 'name') continue;
      if (cand.role === 'measure') continue;
      const k = `${cand.ref.table}.${col}`;
      if (filterRefs.has(k) || measureKeys.has(k) || dimKeys.has(k) || orderByKeys.has(k) || projKeys.has(k)) continue;
      if (isPk(cand.ref.table, col) || fkCols.has(k)) continue;
      projKeys.add(k);
      projection.push({ table: cand.ref.table, column: col });
    }
  }

  const unresolved = [...new Set(
    raw.filter((_, i) => !covered[i]).filter((t) => t.length >= 3 && !skippable(t)),
  )];

  return {
    question,
    tables: [...tables],
    projection,
    measures,
    groupDims: groupDimsOut,
    filters,
    orderBy,
    limit,
    ambiguities,
    unresolved,
  };
}
