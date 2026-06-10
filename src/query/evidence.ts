/**
 * Evidence parser (pure, deterministic — no LLM).
 *
 * BIRD ships a per-question "evidence" string of semi-structured clauses, e.g.
 *   "driver reference name refers to driverRef; first qualifying period refers to q1;
 *    drivers eliminated in the first qualifying period refers to 5 drivers with MAX(q1);
 *    race number refers to raceId"
 *
 * We turn the common clause shapes into `LinkHints` the linker applies deterministically:
 *   - "<phrase> refers to|means|denotes <col>"  → an alias  (phrase → that column)
 *   - "... MAX(<col>) ..." / "... MIN(<col>) ..." with an integer → orderBy + limit
 *   - "<col> = '<value>'"                        → a value illustration
 *
 * Clauses we can't parse are dropped (surfaced as `dropped` for transparency), never
 * guessed — the open-ended cases are the LLM tier's job (Sprint 3b).
 */
import type { OntologyIndex } from './ontology-index.js';
import type { ElementRef, LinkHints } from '../types/query-intent.js';
import { normalize, parseNumberWord } from './text-normalize.js';

export interface ParsedEvidence {
  hints: LinkHints;
  /** Clauses that matched no known shape — kept for visibility / the future LLM tier. */
  dropped: string[];
}

/** Resolve a token like "raceId"/"driverRef"/"q1" to a column ref (preferring a primary key). */
function findColumnByName(token: string, index: OntologyIndex): ElementRef | null {
  const norm = normalize(token).replace(/\s+/g, '');
  if (!norm) return null;
  const matches: Array<{ ref: ElementRef; pk: boolean }> = [];
  for (const [table, cols] of index.columnsByTable) {
    for (const c of cols) {
      if (c.column.toLowerCase() === norm) matches.push({ ref: { table, column: c.column }, pk: Boolean(c.isPrimaryKey) });
    }
  }
  if (matches.length === 0) return null;
  const pk = matches.find((m) => m.pk);
  return (pk ?? (matches[0] as { ref: ElementRef })).ref;
}

/** Split an evidence blob into clauses on `;` and newlines. */
function clausesOf(evidence: string): string[] {
  return evidence
    .split(/[;\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const ALIAS_RE = /^(.*?)\s+(?:refers?\s+to|means|denotes|is|are)\s+(.+?)\.?$/i;
const AGG_RE = /\b(max|min)\s*\(\s*([a-z0-9_]+)\s*\)/i;
const VALUE_RE = /([a-z0-9_]+)\s*=\s*'([^']+)'/i;

/** Parse a BIRD-style evidence string into deterministic LinkHints. */
export function parseEvidence(evidence: string, index: OntologyIndex): ParsedEvidence {
  const hints: LinkHints = { aliases: [], values: [], orderBy: [], limit: null };
  const dropped: string[] = [];

  for (const clause of clausesOf(evidence)) {
    let matched = false;

    // (1) Aggregation + limit: "... N ... MAX(col) ..." → orderBy + limit.
    const agg = AGG_RE.exec(clause);
    if (agg) {
      const dir = agg[1]!.toLowerCase() === 'max' ? 'desc' : 'asc';
      hints.orderBy.push({ column: normalize(agg[2]!).replace(/\s+/g, ''), dir });
      const numTok = clause.split(/\s+/).map((t) => parseNumberWord(normalize(t))).find((n): n is number => n !== null);
      if (numTok != null) hints.limit = numTok;
      matched = true;
    }

    // (2) Value illustration: "<col> = 'value'".
    const val = VALUE_RE.exec(clause);
    if (val) {
      const ref = findColumnByName(val[1]!, index);
      if (ref) {
        hints.values.push({ ref, value: val[2]! });
        matched = true;
      }
    }

    // (3) Alias: "<phrase> refers to <col>" (skip when it was an aggregation clause).
    if (!agg) {
      const m = ALIAS_RE.exec(clause);
      if (m) {
        const phrase = normalize(m[1]!);
        // The target may be a column token, possibly trailing words ("q1" / "the driverRef column").
        const targetTok = m[2]!.split(/\s+/).map((t) => findColumnByName(t, index)).find((r): r is ElementRef => r !== null);
        if (phrase && targetTok) {
          hints.aliases.push({ phrase, ref: targetTok });
          matched = true;
        }
      }
    }

    if (!matched) dropped.push(clause);
  }

  return { hints, dropped };
}
