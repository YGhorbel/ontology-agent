/**
 * FROZEN interfaces for the NL2SQL eval harness.
 *
 * The `System` type is load-bearing: the eventual floor baseline, the five-stage
 * pipeline, and any competitor reimplementation all plug in as this SAME type, so
 * a run is always comparable. Do not widen or rename its shape without an ADR —
 * downstream runs are cited against it.
 *
 * Nothing here imports an LLM, a DB driver, or the ontology generator: the harness
 * measures systems, it is not one of them.
 */

/** One executed result set, columns kept in SELECT order for BY-POSITION matching. */
export interface QueryResult {
  /** Output column names, in position order (informational; matching is positional). */
  columns: string[];
  /** Rows as positional tuples — `rows[i][j]` is row i, column j. */
  rows: unknown[][];
}

/**
 * Read-only handle to one database. The System may use it to introspect; the runner
 * uses it to execute the candidate (and gold) SQL. Implementations MUST be read-only
 * and statement-timeout bounded. `query` rejects on SQL error (runner captures it).
 */
export interface DbHandle {
  readonly dbName: string;
  query(sql: string): Promise<QueryResult>;
}

/**
 * A system under test. Given a question + database (and optionally an ontology), it
 * returns SQL plus optional artifacts/token accounting. `artifacts` and `tokens` are
 * OPTIONAL and empty for now — later sprints (anchoring, subgraph, IR, certificate)
 * fill them; the matcher/runner never require them.
 */
export type System = (input: {
  question: string;
  dbName: string;
  /** Opaque ontology object (the generator's `{ 'qsl:ontology', '@graph' }`); `{}` when absent. */
  ontology: object;
  db: DbHandle;
}) => Promise<{
  sql: string;
  artifacts?: {
    anchors?: unknown;
    subgraph?: unknown;
    ir?: unknown;
    certificate?: unknown;
  };
  tokens?: { prompt: number; completion: number };
}>;

/** One gold (reference) example. `goldRows` is optional pre-captured truth; the runner
 *  otherwise executes `goldSql`. `stratum` partitions the report (difficulty/suite). */
export interface GoldItem {
  id: string;
  dbName: string;
  question: string;
  goldSql: string;
  /** Optional pre-captured gold rows (positional tuples). If absent, runner executes goldSql. */
  goldRows?: unknown[][];
  stratum: string;
  note?: string;
}

/** Per-database ontology provenance recorded in a run (null when no ontology supplied). */
export interface OntologyProvenance {
  dbName: string;
  sourceFingerprint: string | null;
  buildNumber: number | null;
}

/**
 * The header that makes a run citable: what code, what model, what set, what system,
 * what knobs, against which ontology builds. Written once per run (sidecar .header.json).
 */
export interface RunHeader {
  gitSha: string;
  /** Model identifier; "none" for this pure-code sprint (no LLM). */
  modelString: string;
  set: string;
  system: string;
  /** Per-DB ontology fingerprint+build, read from supplied ontology headers; [] when none. */
  ontologies: OntologyProvenance[];
  /** System-tunable knob values recorded for reproducibility. */
  knobs: Record<string, string | number | boolean>;
  /** Prompt template version; "none" here. */
  promptVersion: string;
  startedAt: string;
}

/** One scored line in the JSONL run log (append-only, one per gold item). */
export interface RunRecord {
  id: string;
  dbName: string;
  stratum: string;
  question: string;
  goldSql: string;
  candidateSql: string;
  /** Official BIRD Execution Accuracy (set==set, exact). The comparable headline metric. */
  executionMatchStrict: boolean;
  /** Our richer diagnostic EX: order-aware (top-level ORDER BY) + float epsilon + numeric-text. */
  executionMatch: boolean;
  /** Official BIRD-mini-dev Soft F1 in [0,1] (column-order robust). */
  softF1: number;
  /** Present only when the gold result is a numeric scalar/series (else omitted). */
  numericCorrectness?: boolean;
  /** Present only when SQL execution (gold or candidate) failed. */
  error?: string;
  latencyMs: number;
  /** Candidate SQL execution time (ms), for R-VES; omitted if not separately timed. */
  candExecMs?: number;
  /** Gold SQL execution time (ms), for R-VES; omitted if pre-captured or not timed. */
  goldExecMs?: number;
  tokens: { prompt: number; completion: number };
  artifacts: Record<string, unknown>;
}
