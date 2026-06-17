/**
 * The system-agnostic runner: execute a `System` over a `GoldItem[]`, score every item
 * with BOTH scorers, and write an append-only, crash-safe JSONL log plus a citable header.
 *
 * Trust properties:
 *  - candidate SQL is executed READ-ONLY (the DbHandle is a READ ONLY transaction);
 *  - the gold's order-sensitivity is derived ONCE from its parse, never assumed;
 *  - each result line is flushed immediately (fsync) so a crash keeps completed items;
 *  - run files are NEVER overwritten — the ISO timestamp in the name guarantees uniqueness.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DbHandle, GoldItem, OntologyProvenance, RunHeader, RunRecord, System } from './types.js';
import { asNumericGold, birdStrictMatch, executionMatch, numericCorrectness, softF1 } from './match.js';
import { goldHasTopLevelOrderBy } from './sql.js';

/** Absolute tolerance for numericCorrectness; override with EVAL_NUMERIC_TOL. */
function numericTol(): number {
  const raw = Number(process.env.EVAL_NUMERIC_TOL);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1e-6;
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Read `sourceFingerprint` + `buildNumber` from an ontology object's `qsl:ontology` header. */
export function ontologyProvenance(dbName: string, ontology: object | undefined): OntologyProvenance {
  const header = (ontology as Record<string, unknown> | undefined)?.['qsl:ontology'] as
    | Record<string, unknown>
    | undefined;
  if (!header) return { dbName, sourceFingerprint: null, buildNumber: null };
  const fingerprint =
    typeof header['qsl:sourceFingerprint'] === 'string' ? (header['qsl:sourceFingerprint'] as string) : null;
  let buildNumber: number | null = null;
  const version = header['owl:versionInfo'];
  if (typeof version === 'string') {
    const m = version.match(/build\s+(\d+)/);
    if (m?.[1]) buildNumber = Number(m[1]);
  }
  return { dbName, sourceFingerprint: fingerprint, buildNumber };
}

export interface RunOptions {
  set: string;
  system: string;
  /** Resolve the DbHandle for a database (real PG, or a fake in tests). */
  openDb: (dbName: string) => Promise<DbHandle>;
  /** Optional per-DB ontology objects (keyed by dbName). */
  ontologies?: Record<string, object>;
  modelString?: string;
  promptVersion?: string;
  knobs?: Record<string, string | number | boolean>;
  /** Directory for run files (default eval/runs). */
  runsDir?: string;
  /** ISO timestamp for the run (passed in for determinism in tests). */
  startedAtIso?: string;
}

export interface RunOutcome {
  header: RunHeader;
  records: RunRecord[];
  jsonlPath: string;
  headerPath: string;
}

/** Filesystem-safe slug for run-file names. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

/**
 * Execute `system` over `gold`. Opens one read-only DbHandle per distinct database
 * (reused across that DB's items), scores each item, and persists the JSONL + header.
 */
export async function runSystem(system: System, gold: GoldItem[], opts: RunOptions): Promise<RunOutcome> {
  const startedAt = opts.startedAtIso ?? new Date().toISOString();
  const runsDir = opts.runsDir ?? join('eval', 'runs');
  const base = `${slug(startedAt)}-${slug(opts.set)}-${slug(opts.system)}`;
  const jsonlPath = join(runsDir, `${base}.jsonl`);
  const headerPath = join(runsDir, `${base}.header.json`);
  mkdirSync(dirname(jsonlPath), { recursive: true });

  // Header (citable provenance). Ontology fingerprints are null when none supplied.
  const dbNames = [...new Set(gold.map((g) => g.dbName))];
  const ontologies: OntologyProvenance[] = dbNames.map((db) =>
    ontologyProvenance(db, opts.ontologies?.[db]),
  );
  const header: RunHeader = {
    gitSha: gitSha(),
    modelString: opts.modelString ?? 'none',
    set: opts.set,
    system: opts.system,
    ontologies,
    knobs: opts.knobs ?? {},
    promptVersion: opts.promptVersion ?? 'none',
    startedAt,
  };
  writeFileSync(headerPath, `${JSON.stringify(header, null, 2)}\n`, { flag: 'wx' }); // wx: never overwrite

  // Append-only JSONL, flushed per line. 'wx' so we never clobber an existing run file.
  const fd = openSync(jsonlPath, 'wx');
  const records: RunRecord[] = [];
  const dbCache = new Map<string, DbHandle>();
  const tol = numericTol();

  try {
    for (const item of gold) {
      const t0 = performance.now();
      let candidateSql = '';
      let exStrict = false;
      let exMatch = false;
      let sf1 = 0;
      let numOk: boolean | undefined;
      let goldExecMs: number | undefined;
      let candExecMs: number | undefined;
      let error: string | undefined;
      let tokens = { prompt: 0, completion: 0 };
      let artifacts: Record<string, unknown> = {};

      try {
        let db = dbCache.get(item.dbName);
        if (!db) {
          db = await opts.openDb(item.dbName);
          dbCache.set(item.dbName, db);
        }
        const ontology = opts.ontologies?.[item.dbName] ?? {};

        const out = await system({ question: item.question, dbName: item.dbName, ontology, db });
        candidateSql = out.sql;
        tokens = out.tokens ?? tokens;
        artifacts = (out.artifacts as Record<string, unknown> | undefined) ?? {};

        // Gold rows: pre-captured if provided, else executed read-only (and timed for R-VES).
        let goldRows: unknown[][];
        if (item.goldRows) {
          goldRows = item.goldRows;
        } else {
          const tg = performance.now();
          goldRows = (await db.query(item.goldSql)).rows;
          goldExecMs = Math.round((performance.now() - tg) * 1000) / 1000;
        }
        const tcand = performance.now();
        const candRows = (await db.query(candidateSql)).rows;
        candExecMs = Math.round((performance.now() - tcand) * 1000) / 1000;

        // Official BIRD EX (comparable) + Soft F1 (BIRD), and our richer order-aware EX+.
        exStrict = birdStrictMatch(goldRows, candRows);
        sf1 = softF1(goldRows, candRows);
        exMatch = executionMatch(goldRows, candRows, { orderMatters: goldHasTopLevelOrderBy(item.goldSql) });

        // numericCorrectness APPLIES only when the gold result is a numeric scalar/series.
        const goldNum = asNumericGold(goldRows);
        if (goldNum !== null) {
          const candNum = asNumericGold(candRows);
          numOk = candNum === null ? false : numericCorrectness(goldNum, candNum, tol).ok;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const record: RunRecord = {
        id: item.id,
        dbName: item.dbName,
        stratum: item.stratum,
        question: item.question,
        goldSql: item.goldSql,
        candidateSql,
        executionMatchStrict: exStrict,
        executionMatch: exMatch,
        softF1: sf1,
        ...(numOk !== undefined ? { numericCorrectness: numOk } : {}),
        ...(error !== undefined ? { error } : {}),
        latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
        ...(candExecMs !== undefined ? { candExecMs } : {}),
        ...(goldExecMs !== undefined ? { goldExecMs } : {}),
        tokens,
        artifacts,
      };
      records.push(record);
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd); // crash-safe: each completed item survives a crash
    }
  } finally {
    closeSync(fd);
    for (const db of dbCache.values()) {
      const closable = db as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
    }
  }

  return { header, records, jsonlPath, headerPath };
}
