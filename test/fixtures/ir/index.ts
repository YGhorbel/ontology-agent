/**
 * Hand-authored IR fixtures for the Stage-3b compiler gate, paired with REAL Stage-2
 * payloads. Payloads come from running the genuine extractor (`buildGraph` +
 * `loadCapabilities` + `extractSubgraph`) over the committed formula1 fixture — never
 * mocks. `anchored` forces the trimmer to retain the columns the IR references (exactly
 * what Stage-1 anchoring guarantees in production); without it a measure/filter column
 * — and its enriched temporalityEvidence / isNumericText — would never reach the payload.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraph, loadCapabilities } from '../../../src/query/graph-build.js';
import { extractSubgraph } from '../../../src/query/subgraph.js';
import type { SubgraphPayload } from '../../../src/query/graph-model.js';
import { datatypePropertyIri } from '../../../src/types/ontology.js';
import type { MetricQueryIR } from '../../../src/query/ir.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

export const classIriOf = (t: string): string => `qsl:class/${t}`;
export const prop = datatypePropertyIri; // (table, column) -> qsl:property/<table>/<column>

const caps = loadCapabilities(raw);

export interface PayloadOpts {
  uniform?: boolean;
  /** columns to retain per table (mirrors Stage-1 anchoring) */
  anchored?: Record<string, string[]>;
}

/** Build a real Stage-2 payload for a set of terminal tables. */
export function payloadFor(terminals: string[], opts: PayloadOpts = {}): SubgraphPayload {
  const graph = buildGraph(raw, opts.uniform ? { uniform: true } : {});
  const anchoredColumns = new Map<string, string[]>();
  for (const [t, cols] of Object.entries(opts.anchored ?? {})) anchoredColumns.set(classIriOf(t), cols);
  return extractSubgraph(graph, terminals.map(classIriOf), [], caps, { anchoredColumns });
}

// ── Capability IRIs are literal slugs from the ontology (not column-derived). ──
export const CAP_AVG_LAP_MS = 'qsl:capability/metric/laptimes/average-lap-time-ms'; // AVG(laptimes.milliseconds)

// 1. Simple capability metric over a declared-join tree.
export const ir1: MetricQueryIR = {
  measures: [{ capability: CAP_AVG_LAP_MS, alias: 'avg_ms' }],
  groupBy: [{ property: prop('constructors', 'nationality') }],
  filters: [{ property: prop('constructors', 'nationality'), op: '=', value: 'British' }],
};

// 2. Composite-join rendering (uniform mode picks the laptimes↔driverstandings 2-key edge).
export const ir2: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'COUNT', property: prop('laptimes', 'milliseconds') }, alias: 'n' }],
};

// 4a. Cumulative-snapshot rewrite (H2): SUM over a running total → de-cumulate per (driver, season).
export const ir4cumulative: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'SUM', property: prop('driverstandings', 'points') }, alias: 'total_points' }],
  groupBy: [{ property: prop('races', 'year') }],
};

// 4b. Contrast: results.points is per-race → a plain SUM is correct.
export const ir4perRace: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'SUM', property: prop('results', 'points') }, alias: 'total_points' }],
};

// 6a. Numeric-text column (pitstops.duration is text) → CAST before aggregating.
export const ir6numericText: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'AVG', property: prop('pitstops', 'duration') }, alias: 'avg_dur' }],
  filters: [{ property: prop('pitstops', 'duration'), op: '>', value: 20000 }],
};

// 6b. A genuinely numeric column → no cast.
export const ir6numeric: MetricQueryIR = {
  measures: [{ aggExpr: { fn: 'AVG', property: prop('pitstops', 'milliseconds') }, alias: 'avg_ms' }],
};
