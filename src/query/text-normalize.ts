/**
 * Text normalization + fuzzy string matching (pure, dependency-free).
 *
 * The schema linker matches question spans against ontology element labels and
 * column value dictionaries. To compare them fairly we normalize both sides the
 * same way (lowercase, strip diacritics/punctuation, drop function words,
 * singularize) and fall back to edit-distance / trigram similarity for typos.
 *
 * Written by hand rather than pulling a Levenshtein package — keeps the project's
 * zero-runtime-dependency discipline and the algorithm is a few lines.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Query-framing / function words that carry no schema reference — dropped from spans. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'or', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'show', 'me', 'list', 'give',
  'get', 'display', 'find', 'fetch', 'what', 'which', 'who', 'whose', 'how', 'that', 'this',
  'these', 'those', 'please', 'their', 'its', 'over', 'into', 'than', 'about',
]);

/** Aggregation / grouping cue words: kept as content (distinguish multi-word labels) but
 * never reported as `unresolved`, and `by`/`per`/`each` trigger group-by detection. */
const CUE_WORDS = new Set([
  'by', 'per', 'each', 'group', 'grouped', 'total', 'number', 'count', 'sum', 'average',
  'avg', 'mean', 'max', 'maximum', 'min', 'minimum', 'most', 'least', 'top', 'highest', 'lowest',
]);

export const isStopword = (t: string): boolean => STOPWORDS.has(t);
export const isCue = (t: string): boolean => CUE_WORDS.has(t);

/** Light singularization: `races`->`race`, `companies`->`company`, `buses`->`bus`. */
export function singularize(tok: string): string {
  if (tok.length > 4 && tok.endsWith('ies')) return `${tok.slice(0, -3)}y`;
  if (tok.length > 4 && tok.endsWith('ses')) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss') && !tok.endsWith('us')) {
    return tok.slice(0, -1);
  }
  return tok;
}

/** Raw normalized tokens with stopwords removed (NOT singularized) — used for value matching. */
export function rawTokens(s: string): string[] {
  return normalize(s).split(' ').filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Content tokens for name matching: stopwords removed and singularized. */
export function tokenize(s: string): string[] {
  return rawTokens(s).map(singularize);
}

/** All 1..n-gram contiguous spans of a token list, de-duplicated, longest collected too. */
export function spans(tokens: string[], n = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (let len = 1; len <= n && i + len <= tokens.length; len += 1) {
      out.push(tokens.slice(i, i + len).join(' '));
    }
  }
  return [...new Set(out)];
}

/** Optimal string alignment (Damerau-Levenshtein with adjacent transpositions). */
export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i += 1) d[i]![0] = i;
  for (let j = 0; j <= bl; j += 1) d[0]![j] = j;
  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[al]![bl]!;
}

/** Edit-distance similarity in [0,1] (1 = identical). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - damerauLevenshtein(a, b) / maxLen;
}

/** Padded character trigrams of a string. */
export function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard trigram similarity in [0,1] — a cheap fallback for longer phrases. */
export function trigramSim(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

// ---------------------------------------------------------------------------
// Skeleton cues (Sprint 3a): projection verbs, superlatives, and number parsing.
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
};

/** Parse a digit string or a small number word to an integer, else null. */
export function parseNumberWord(tok: string): number | null {
  if (/^\d+$/.test(tok)) return Number(tok);
  const w = NUMBER_WORDS[tok];
  return w ?? null;
}

/** A pure integer literal token (used to exclude numerics from value-dict matching). */
export const isNumericLiteral = (tok: string): boolean => /^\d+$/.test(tok);

const PROJECTION_CUES = new Set(['list', 'show', 'give', 'display', 'name', 'names', 'which', 'what', 'find', 'return']);
export const isProjectionCue = (tok: string): boolean => PROJECTION_CUES.has(tok);

/** Superlative / ordering words → sort direction (desc = "the most/highest/slowest"). */
export const SUPERLATIVE_DIR = new Map<string, 'asc' | 'desc'>([
  ['most', 'desc'], ['highest', 'desc'], ['largest', 'desc'], ['greatest', 'desc'], ['maximum', 'desc'],
  ['max', 'desc'], ['top', 'desc'], ['slowest', 'desc'], ['longest', 'desc'], ['latest', 'desc'], ['oldest', 'desc'],
  ['least', 'asc'], ['lowest', 'asc'], ['smallest', 'asc'], ['minimum', 'asc'], ['min', 'asc'],
  ['fastest', 'asc'], ['shortest', 'asc'], ['earliest', 'asc'], ['newest', 'asc'], ['bottom', 'asc'],
]);
export const isSuperlative = (tok: string): boolean => SUPERLATIVE_DIR.has(tok);

/**
 * Superlatives whose sort polarity depends on the metric, not the word: "fastest lap
 * *time*" wants the smallest value (asc) but "fastest lap *speed*" wants the largest
 * (desc). The `SUPERLATIVE_DIR` default reads them as time-like; `directionFor` flips
 * them when the ranking column reads as a speed/rate/score.
 */
const POLARITY_AMBIGUOUS = new Set(['fastest', 'slowest']);
/** Metric labels where a larger value is "more"/"faster" (higher = better). */
const SPEED_LIKE = /\b(speed|rate|velocity|score|points?|throughput|frequency|kph|mph|rpm)\b/i;
/** Metric labels where a smaller value is "less"/"faster" (lower = better). */
const TIME_LIKE = /\b(time|times|duration|seconds?|minutes?|hours?|age|delay|latency|gap|interval)\b/i;

/**
 * Resolve a superlative word to a sort direction. Unambiguous words use
 * `SUPERLATIVE_DIR` verbatim; polarity-ambiguous words (`fastest`/`slowest`) are
 * decided by the ranking column's label — speed-like → larger is faster, time-like →
 * smaller is faster — falling back to the time-like default when neither matches.
 */
export function directionFor(word: string, columnLabel = ''): 'asc' | 'desc' {
  const base = SUPERLATIVE_DIR.get(word) ?? 'desc';
  if (!POLARITY_AMBIGUOUS.has(word)) return base;
  if (SPEED_LIKE.test(columnLabel)) return word === 'fastest' ? 'desc' : 'asc';
  if (TIME_LIKE.test(columnLabel)) return word === 'fastest' ? 'asc' : 'desc';
  return base;
}
