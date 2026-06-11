/**
 * Semantic validation of metric `formulaHint`s (Fix 2).
 *
 * Four layered checks, each independent so a failure pinpoints the cause:
 *   1. parse    — the formula is valid PostgreSQL expression syntax.
 *   2. bind     — every qualified `table.column` reference exists in the schema.
 *   3. dry-run  — `SELECT <formula> FROM <referenced tables> LIMIT 1` executes (read-only,
 *                 statement-timeout bounded). Catches runtime/type errors a static check misses.
 *   4. type     — the result is numeric when the unit is numeric-like; a numeric-text source
 *                 column must be CAST before it is aggregated (lexical order is wrong).
 *
 * Parser choice: `pgsql-ast-parser` — a pure-TypeScript, zero-runtime-dependency PostgreSQL
 * grammar. It avoids node-sql-parser's multi-dialect ambiguity and needs no native build, so
 * it runs the same in CI and in the browser-free Node pipeline. We only need to (a) confirm the
 * expression parses and (b) walk it for qualified column references — both first-class here.
 */
import { parse, type Statement } from 'pgsql-ast-parser';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnFact } from '../types/column-fact.js';
import type { Queryable } from '../storage/pg.js';
import type { ValidationError } from '../types/ontology.js';

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** PostgreSQL types pg_typeof may report for a numeric result. */
const NUMERIC_PG_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'money',
]);

/** Units that imply a numeric result. Non-matching units skip the numeric type check. */
function isNumericLikeUnit(unit: string | undefined): boolean {
  if (!unit) return false;
  return /eur|usd|gbp|count|number|num|days?|hours?|min|sec|ms|millisecond|points?|amount|ratio|rate|percent|%|score|km|mph|kph|speed|distance|weight|age|year|currency|total/i.test(
    unit,
  );
}

export interface QualifiedRef {
  table: string;
  column: string;
}

/** Recursively collect qualified `table.column` references from a parsed AST node. */
function collectRefs(node: unknown, out: QualifiedRef[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'ref' && typeof obj['name'] === 'string') {
    const table = obj['table'] as { name?: string } | undefined;
    if (table?.name) out.push({ table: table.name, column: obj['name'] });
  }
  for (const key of Object.keys(obj)) {
    if (key === 'type') continue;
    collectRefs(obj[key], out);
  }
}

/** Parse a formula expression by wrapping it in a trivial SELECT. Returns null on syntax error. */
export function parseFormula(formula: string): Statement[] | null {
  try {
    return parse(`SELECT ${formula} AS __qsl_probe`);
  } catch {
    return null;
  }
}

/** Qualified column references in a formula (empty if it does not parse). */
export function referencedColumns(formula: string): QualifiedRef[] {
  const ast = parseFormula(formula);
  if (!ast) return [];
  const out: QualifiedRef[] = [];
  collectRefs(ast, out);
  return out;
}

const stmtTimeoutFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
};

export const dryRunEnabled = (): boolean =>
  String(process.env.ONTOLOGY_VALIDATE_DRY_RUN ?? '').trim().toLowerCase() !== 'false';

export interface FormulaCheckInput {
  /** @id of the capability node (used as the error subject). */
  subject: string;
  formula: string;
  unit: string | undefined;
  /** Fallback scope table when the formula has no qualified references. */
  scopeTable: string;
  schema: CanonicalSchema;
  columnFacts: ColumnFact[];
}

export interface FormulaCheckResult {
  errors: ValidationError[];
  /** Which checks passed cleanly — feeds Fix 9's validationEvidence. */
  passed: Array<'parse' | 'bind' | 'dry-run' | 'type'>;
}

/** Static checks (parse + bind + numeric-text CAST). No DB — always safe to run. */
export function checkFormulaStatic(input: FormulaCheckInput): FormulaCheckResult {
  const { subject, formula, unit, schema, columnFacts } = input;
  const errors: ValidationError[] = [];
  const passed: FormulaCheckResult['passed'] = [];

  const ast = parseFormula(formula);
  if (!ast) {
    errors.push({ rule: 'formula-parse', subject, message: `formula does not parse: ${formula}`, origin: 'capability' });
    return { errors, passed };
  }
  passed.push('parse');

  const refs: QualifiedRef[] = [];
  collectRefs(ast, refs);

  const columnSet = new Set<string>();
  for (const t of schema.tables) for (const c of t.columns) columnSet.add(`${t.name}.${c.name}`.toLowerCase());

  let bindOk = true;
  for (const r of refs) {
    if (!columnSet.has(`${r.table}.${r.column}`.toLowerCase())) {
      bindOk = false;
      errors.push({
        rule: 'formula-bind',
        subject,
        message: `formula references unknown column ${r.table}.${r.column}`,
        origin: 'capability',
      });
    }
  }
  if (bindOk) passed.push('bind');

  // Numeric-text source columns must be CAST before aggregation/sort.
  const numericTextCols = new Set(
    columnFacts.filter((f) => f.isNumericText).map((f) => `${f.table}.${f.column}`.toLowerCase()),
  );
  const usesNumericText = refs.some((r) => numericTextCols.has(`${r.table}.${r.column}`.toLowerCase()));
  const hasCast = /\bcast\s*\(|::/i.test(formula);
  if (usesNumericText && !hasCast) {
    errors.push({
      rule: 'formula-type',
      subject,
      message: `formula aggregates a numeric-text column without a CAST: ${formula}`,
      origin: 'capability',
    });
  }

  return { errors, passed };
}

/** Tables referenced by a formula (deduped), falling back to the scope table. */
function fromTables(refs: QualifiedRef[], scopeTable: string): string[] {
  const tables = [...new Set(refs.map((r) => r.table))];
  return tables.length > 0 ? tables : [scopeTable];
}

/**
 * Dry-run + numeric type check against the live DB (read-only, statement-timeout bounded).
 * Returns extra errors/passes on top of the static checks. Skipped by the caller when
 * dry-run is disabled or static checks already failed parse/bind.
 */
export async function checkFormulaDryRun(
  q: Queryable,
  input: FormulaCheckInput,
): Promise<FormulaCheckResult> {
  const { subject, formula, unit, scopeTable } = input;
  const errors: ValidationError[] = [];
  const passed: FormulaCheckResult['passed'] = [];

  const refs = referencedColumns(formula);
  const from = fromTables(refs, scopeTable).map(quoteIdent).join(', ');
  try {
    await q.query(`SET LOCAL statement_timeout = ${stmtTimeoutFromEnv()}`);
    const sql = `SELECT pg_typeof((${formula}))::text AS t FROM ${from} LIMIT 1`;
    const { rows } = await q.query(sql);
    passed.push('dry-run');
    const resultType = typeof rows[0]?.['t'] === 'string' ? (rows[0]['t'] as string) : null;
    if (resultType !== null) {
      if (isNumericLikeUnit(unit) && !NUMERIC_PG_TYPES.has(resultType.toLowerCase())) {
        errors.push({
          rule: 'formula-type',
          subject,
          message: `formula with numeric unit "${unit}" yields non-numeric type ${resultType}`,
          origin: 'capability',
        });
      } else {
        passed.push('type');
      }
    }
  } catch (err) {
    errors.push({
      rule: 'formula-dry-run',
      subject,
      message: `formula failed to execute: ${err instanceof Error ? err.message : String(err)}`,
      origin: 'capability',
    });
  }
  return { errors, passed };
}
