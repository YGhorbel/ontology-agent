/**
 * Link surface (pure, stage-1 of schema linking).
 *
 * Flattens the ontology index into a flat list of `LinkTarget`s — one searchable
 * record per class, column, and capability — with their labels pre-normalized into
 * comparable token surfaces and (for columns) their value dictionaries attached.
 * The schema linker scans these to match question spans.
 *
 * Roles come from the ontology, not from guessing: a metric capability's column is a
 * `measure`; a low-cardinality non-key text column is a `dimension`; a class is an
 * `entity`; everything else is an `attribute`.
 */
import type { OntologyIndex } from './ontology-index.js';
import type { LinkRole } from '../types/query-intent.js';
import { typeFamily } from '../profiling/candidate-pairs.js';
import { normalize, tokenize } from './text-normalize.js';

export type TargetKind = 'class' | 'column' | 'capability';

export interface LinkTarget {
  ref: { table: string; column?: string };
  kind: TargetKind;
  role: LinkRole;
  /** Normalized surface phrases (prefLabel ∪ altLabel ∪ name), de-duplicated. */
  surfaces: string[];
  /** Token arrays parallel to `surfaces` (same index). */
  surfaceTokens: string[][];
  /** Normalized value dictionary for the value channel; empty when none. */
  sampleValues: string[];
  /** Normalized tokens of the rdfs:comment — a low-weight surface (multi-word spans only). */
  commentTokens: string[];
  /** prefLabel of the capability, when this target is one. */
  capability?: string;
}

/** Build the de-duplicated normalized surfaces for a set of raw label strings. */
function buildSurfaces(labels: Array<string | undefined>): { surfaces: string[]; surfaceTokens: string[][] } {
  const surfaces: string[] = [];
  const surfaceTokens: string[][] = [];
  for (const label of labels) {
    if (!label) continue;
    const toks = tokenize(label);
    if (toks.length === 0) continue;
    const phrase = toks.join(' ');
    if (!surfaces.includes(phrase)) {
      surfaces.push(phrase);
      surfaceTokens.push(toks);
    }
  }
  return { surfaces, surfaceTokens };
}

const key = (table: string, column: string): string => `${table} ${column}`;

export function buildLinkTargets(index: OntologyIndex): LinkTarget[] {
  const targets: LinkTarget[] = [];

  // Classes → entity targets (prefLabel ∪ altLabel ∪ table name).
  for (const ci of index.classes.values()) {
    const { surfaces, surfaceTokens } = buildSurfaces([ci.prefLabel, ...ci.altLabel, ci.table]);
    if (surfaces.length > 0) {
      targets.push({ ref: { table: ci.table }, kind: 'class', role: 'entity', surfaces, surfaceTokens, sampleValues: [], commentTokens: tokenize(ci.comment) });
    }
  }

  // Capabilities → measure/dimension/attribute targets. Record metric columns so the
  // matching column target also gets the `measure` role.
  const measureCols = new Set<string>();
  for (const cap of index.capabilities) {
    if (cap.kind === 'metric' && cap.scopeColumn) measureCols.add(key(cap.scopeTable, cap.scopeColumn));
    const role: LinkRole =
      cap.kind === 'metric' ? 'measure' : cap.kind === 'dimension' ? 'dimension' : cap.kind === 'timeGrain' ? 'attribute' : 'entity';
    const ref = cap.scopeColumn ? { table: cap.scopeTable, column: cap.scopeColumn } : { table: cap.scopeTable };
    const { surfaces, surfaceTokens } = buildSurfaces([cap.prefLabel, ...cap.altLabel]);
    if (surfaces.length > 0) {
      targets.push({ ref, kind: 'capability', role, surfaces, surfaceTokens, sampleValues: [], commentTokens: [], capability: cap.prefLabel });
    }
  }

  // Columns → measure (if a metric column), dimension (low-card non-key text), else attribute.
  for (const [table, cols] of index.columnsByTable) {
    for (const col of cols) {
      const sampleValues = (col.sampleValues ?? []).map(normalize).filter((v) => v.length > 0);
      const isMeasure = measureCols.has(key(table, col.column));
      const isKey = Boolean(col.isPrimaryKey || col.isUnique);
      const isTextish = col.dataType ? typeFamily(col.dataType) !== 'numeric' : true;
      const role: LinkRole = isMeasure
        ? 'measure'
        : sampleValues.length > 0 && !isKey && isTextish
          ? 'dimension'
          : 'attribute';
      const { surfaces, surfaceTokens } = buildSurfaces([col.prefLabel, ...col.altLabel, col.column]);
      if (surfaces.length > 0) {
        targets.push({ ref: { table, column: col.column }, kind: 'column', role, surfaces, surfaceTokens, sampleValues, commentTokens: tokenize(col.comment) });
      }
    }
  }

  return targets;
}
