/**
 * Node 5 — Validator (deterministic; DB only for the optional formula dry-run).
 *
 * Assembles the JSON-LD ontology from the candidates/relationships/capabilities,
 * then runs structural + semantic rules. Errors are *collected*, not thrown, so the
 * graph can decide retry-vs-persist. Each error carries an `origin` (`concept` →
 * node 2, `capability` → node 4) that drives the ⑤→② vs ⑤→④ retry routing.
 *
 * The formula dry-run (Fix 2) is the one DB touch: a read-only, statement-timeout
 * bounded `SELECT <formula> …` per metric, run only when a connector is injected and
 * `ONTOLOGY_VALIDATE_DRY_RUN` is not "false". It may run up to retries+1 times.
 */
import { assembleOntology } from '../assemble.js';
import type { CanonicalSchema } from '../../types/canonical-schema.js';
import type { ColumnFact } from '../../types/column-fact.js';
import { type OntologyJsonLd, type ValidationError } from '../../types/ontology.js';
import type { SchemaConnector } from '../../storage/pg.js';
import { enumMaxDistinctFromEnv } from '../../profiling/column-facts.js';
import {
  checkFormulaStatic,
  checkFormulaDryRun,
  dryRunEnabled,
} from '../../validation/formula-validator.js';
import { normalize, singularize } from '../../query/text-normalize.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

const FORMULA_TOKEN = /\b([a-zA-Z_][A-Za-z0-9_]*)\.([a-zA-Z_][A-Za-z0-9_]*)\b/g;
/** Quoted example values in a comment, e.g. 'Finished'. */
const QUOTED_TOKEN = /'([^']*)'/g;
/** A direct SUM over a qualified column, e.g. SUM(driverstandings.points). */
const SUM_OF_COLUMN = /\bsum\s*\(\s*([a-zA-Z_][A-Za-z0-9_]*)\.([a-zA-Z_][A-Za-z0-9_]*)\s*\)/gi;

const lc = (s: string): string => s.toLowerCase();
/** Last path segment of a class IRI, e.g. "qsl:class/orders" -> "orders". */
const tableTokenOf = (classIriValue: string): string => {
  const parts = classIriValue.split('/');
  return parts[parts.length - 1] ?? classIriValue;
};

/** Pure validator (no DB), exported for direct unit testing. */
export function validateOntology(
  ontology: OntologyJsonLd,
  schema: CanonicalSchema,
  columnFacts: ColumnFact[] = [],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const graph = ontology['@graph'];

  const classIds = new Set(graph.filter((n) => n['@type'] === 'owl:Class').map((n) => n['@id']));
  const factByCol = new Map<string, ColumnFact>();
  for (const f of columnFacts) factByCol.set(`${lc(f.table)}.${lc(f.column)}`, f);
  const enumMax = enumMaxDistinctFromEnv();

  // Rule 1: every objectProperty has a domain & range that exist as classes.
  for (const n of graph) {
    if (n['@type'] !== 'owl:ObjectProperty') continue;
    const domain = n['rdfs:domain']['@id'];
    const range = n['rdfs:range']['@id'];
    if (!classIds.has(domain)) {
      errors.push({ rule: 'object-property-domain-range', subject: n['@id'], message: `domain ${domain} is not a defined class` });
    }
    if (!classIds.has(range)) {
      errors.push({ rule: 'object-property-domain-range', subject: n['@id'], message: `range ${range} is not a defined class` });
    }
  }

  // Rule 2: every metric formula references columns that exist in the schema.
  const columnRefs = new Set<string>();
  for (const t of schema.tables) for (const c of t.columns) columnRefs.add(`${t.name}.${c.name}`.toLowerCase());
  for (const n of graph) {
    if (n['@type'] !== 'qsl:Capability' || n['qsl:kind'] !== 'metric') continue;
    const formula = n['qsl:formulaHint'];
    if (!formula) continue;
    for (const m of formula.matchAll(FORMULA_TOKEN)) {
      const ref = `${m[1]}.${m[2]}`.toLowerCase();
      if (!columnRefs.has(ref)) {
        errors.push({ rule: 'metric-formula-columns', subject: n['@id'], message: `formula references unknown column ${m[1]}.${m[2]}`, origin: 'capability' });
      }
    }
    // Fix 2 (static): parse + numeric-text CAST. Column existence handled above, so
    // suppress the validator's own bind errors to avoid duplicate "unknown column".
    const scopeTable = tableTokenOf(n['qsl:scopeClass']);
    const stat = checkFormulaStatic({ subject: n['@id'], formula, unit: n['qsl:unit'], scopeTable, schema, columnFacts });
    errors.push(...stat.errors.filter((e) => e.rule !== 'formula-bind'));

    // Fix 3 (backstop): hard-fail a direct SUM over a cumulative-snapshot column.
    for (const m of formula.matchAll(SUM_OF_COLUMN)) {
      const fact = factByCol.get(`${lc(m[1] ?? '')}.${lc(m[2] ?? '')}`);
      if (fact?.temporality === 'cumulative-snapshot') {
        errors.push({ rule: 'cumulative-no-sum', subject: n['@id'], message: `SUM(${m[1]}.${m[2]}) double-counts a cumulative-snapshot measure — use MAX or last-value-per-group`, origin: 'capability' });
      }
    }
  }

  // Rule 3: SKOS prefLabel unique within scope (class / per-domain property / capability buckets).
  const seen = new Map<string, Set<string>>();
  const checkUnique = (bucket: string, label: string, subject: string): void => {
    const set = seen.get(bucket) ?? new Set<string>();
    if (set.has(label.toLowerCase())) {
      errors.push({ rule: 'skos-preflabel-unique', subject, message: `duplicate prefLabel "${label}" within scope ${bucket}` });
    }
    set.add(label.toLowerCase());
    seen.set(bucket, set);
  };
  for (const n of graph) {
    if (n['@type'] === 'owl:Class') checkUnique('class', n['skos:prefLabel'], n['@id']);
    else if (n['@type'] === 'owl:DatatypeProperty') checkUnique(`prop:${n['rdfs:domain']['@id']}`, n['skos:prefLabel'], n['@id']);
    else if (n['@type'] === 'qsl:Capability' && n['skos:prefLabel']) checkUnique('capability', n['skos:prefLabel'], n['@id']);
  }

  // Rule 4: no orphan classes (each class referenced by >=1 property/relationship/capability).
  const referenced = new Set<string>();
  for (const n of graph) {
    if (n['@type'] === 'owl:DatatypeProperty') referenced.add(n['rdfs:domain']['@id']);
    else if (n['@type'] === 'owl:ObjectProperty') {
      referenced.add(n['rdfs:domain']['@id']);
      referenced.add(n['rdfs:range']['@id']);
    } else if (n['@type'] === 'qsl:Capability') referenced.add(n['qsl:scopeClass']);
  }
  for (const id of classIds) {
    if (!referenced.has(id)) errors.push({ rule: 'orphan-class', subject: id, message: `class ${id} has no properties or relationships` });
  }

  // Rule 5 (Fix 1): a comment may only cite example values present in the column's samples
  // (enforced only for small enumerations, where we have a trustworthy ground truth).
  for (const n of graph) {
    if (n['@type'] !== 'owl:DatatypeProperty') continue;
    const fact = factByCol.get(`${lc(n['qsl:mapsToTable'])}.${lc(n['qsl:mapsToColumn'])}`);
    if (!fact || fact.distinctCount === null || fact.distinctCount > enumMax || fact.sampleValues.length === 0) continue;
    const allowed = new Set(fact.sampleValues.map(lc));
    for (const m of n['rdfs:comment'].matchAll(QUOTED_TOKEN)) {
      const token = (m[1] ?? '').trim();
      if (token === '') continue;
      if (!allowed.has(lc(token))) {
        errors.push({
          rule: 'comment-cites-known-values',
          subject: n['@id'],
          message: `comment cites '${token}' which is not among ${n['qsl:mapsToColumn']}'s sampled values [${fact.sampleValues.join(', ')}]`,
          origin: 'concept',
        });
      }
    }
  }

  return errors;
}

/**
 * @param connect optional connector to the *target* DB; enables the Fix 2 formula
 *   dry-run. Omitted in pure unit tests, which then run static checks only.
 */
/** Normalize a label for collision comparison: lowercase, strip punctuation, singularize. */
const normLabel = (s: string): string => normalize(s).split(' ').map(singularize).filter(Boolean).join(' ');

/**
 * Fix 8 — drop a generated altLabel that collides with a DIFFERENT property/class's concept
 * (its prefLabel, its `table column`, or its column name). Prevents `results.grid`'s
 * "Qualifying position" from hijacking queries that mean `qualifying.position`. Mutates the
 * graph and returns warnings (the run is not failed — a dropped synonym is a soft fix).
 */
export function pruneCollidingAltLabels(ontology: OntologyJsonLd): string[] {
  const warnings: string[] = [];
  const owners = new Map<string, Set<string>>();
  const own = (identity: string, id: string): void => {
    if (!identity) return;
    const set = owners.get(identity) ?? new Set<string>();
    set.add(id);
    owners.set(identity, set);
  };
  for (const n of ontology['@graph']) {
    if (n['@type'] === 'owl:Class') {
      own(normLabel(n['skos:prefLabel']), n['@id']);
      own(normLabel(n['qsl:mapsToTable']), n['@id']);
    } else if (n['@type'] === 'owl:DatatypeProperty') {
      own(normLabel(n['skos:prefLabel']), n['@id']);
      own(normLabel(`${n['qsl:mapsToTable']} ${n['qsl:mapsToColumn']}`), n['@id']);
      own(normLabel(n['qsl:mapsToColumn']), n['@id']);
    }
  }
  for (const n of ontology['@graph']) {
    if (n['@type'] !== 'owl:Class' && n['@type'] !== 'owl:DatatypeProperty') continue;
    const alt = n['skos:altLabel'];
    if (!alt || alt.length === 0) continue;
    const kept: string[] = [];
    for (const a of alt) {
      const foreign = [...(owners.get(normLabel(a)) ?? [])].filter((o) => o !== n['@id']);
      if (foreign.length > 0) warnings.push(`dropped altLabel "${a}" on ${n['@id']} — collides with ${foreign.join(', ')}`);
      else kept.push(a);
    }
    if (kept.length !== alt.length) {
      if (kept.length > 0) n['skos:altLabel'] = kept;
      else delete (n as { 'skos:altLabel'?: string[] })['skos:altLabel'];
    }
  }
  return warnings;
}

/** Per-event phrasing ("X points awarded for this race/entry") on a measure column. */
const PER_EVENT_PHRASING =
  /\b(award(?:ed|s)?|earn(?:ed|s)?|gain(?:ed|s)?|scored|received)\b[^.]*\b(?:for|in|this|per|each)\b[^.]*\b(?:race|event|entry|round|standing)\b/i;
/** Cumulative phrasing that, if present, means the comment already frames the value correctly. */
const CUMULATIVE_PHRASING =
  /\b(?:cumulative|running total|running tally|accumulat\w*|as of|to date|so far|season total|standings? total)\b/i;

/**
 * Part 2d — warn (do NOT fail) when a column tagged `cumulative-snapshot` is described with
 * per-event phrasing ("points awarded for this race") instead of as a running total. This is a
 * heuristic over free text, so a hard-fail retry loop would be brittle and could thrash on a
 * stubborn LLM; the prompt already steers the wording, and this surfaces residual mismatches as
 * warnings (origin: concept) without blocking the build. Returns one warning per offending column.
 */
export function warnCumulativeCommentPhrasing(ontology: OntologyJsonLd, columnFacts: ColumnFact[]): string[] {
  const tagged = new Set<string>();
  for (const f of columnFacts) if (f.temporality === 'cumulative-snapshot') tagged.add(`${lc(f.table)}.${lc(f.column)}`);
  if (tagged.size === 0) return [];
  const warnings: string[] = [];
  for (const n of ontology['@graph']) {
    if (n['@type'] !== 'owl:DatatypeProperty') continue;
    if (!tagged.has(`${lc(n['qsl:mapsToTable'])}.${lc(n['qsl:mapsToColumn'])}`)) continue;
    const comment = n['rdfs:comment'];
    if (PER_EVENT_PHRASING.test(comment) && !CUMULATIVE_PHRASING.test(comment)) {
      warnings.push(
        `[cumulative-comment-phrasing] ${n['@id']}: "${comment}" describes a cumulative-snapshot column as a per-event amount — should read as a running/cumulative total`,
      );
    }
  }
  return warnings;
}

export function createValidateNode(connect?: SchemaConnector) {
  return async function validate(state: OntologyState): Promise<OntologyStateUpdate> {
    const { canonicalSchema, conceptCandidates, relationships, capabilities } = state;
    if (!canonicalSchema || !conceptCandidates || !relationships || !capabilities) {
      throw new Error('validate: required prior state is missing.');
    }
    const columnFacts = state.columnFacts ?? [];
    const ontology = assembleOntology(conceptCandidates, relationships, capabilities, columnFacts);

    // Fix 8: strip altLabels that collide with a different concept (soft — warn, don't fail).
    for (const w of pruneCollidingAltLabels(ontology)) console.warn(`[validate] ${w}`);

    // Part 2d: warn (don't fail) on per-event phrasing for cumulative-snapshot columns.
    for (const w of warnCumulativeCommentPhrasing(ontology, columnFacts)) console.warn(`[validate] ${w}`);

    const validationErrors = validateOntology(ontology, canonicalSchema, columnFacts);

    // Fix 2 dry-run (DB) — only metrics that already passed parse/bind, to avoid noise.
    let dryRanFormulas = false;
    if (connect && state.pgConnectionString && dryRunEnabled()) {
      const brokenSubjects = new Set(
        validationErrors
          .filter((e) => e.rule === 'formula-parse' || e.rule === 'formula-bind' || e.rule === 'metric-formula-columns')
          .map((e) => e.subject),
      );
      const metrics = ontology['@graph'].filter(
        (n): n is Extract<typeof n, { '@type': 'qsl:Capability' }> =>
          n['@type'] === 'qsl:Capability' && n['qsl:kind'] === 'metric' && !!n['qsl:formulaHint'] && !brokenSubjects.has(n['@id']),
      );
      if (metrics.length > 0) {
        const client = await connect(state.pgConnectionString);
        try {
          for (const n of metrics) {
            const res = await checkFormulaDryRun(client, {
              subject: n['@id'],
              formula: n['qsl:formulaHint'] as string,
              unit: n['qsl:unit'],
              scopeTable: tableTokenOf(n['qsl:scopeClass']),
              schema: canonicalSchema,
              columnFacts,
            });
            validationErrors.push(...res.errors);
          }
        } finally {
          await client.close();
        }
      }
      dryRanFormulas = true;
    }

    // Fix 9: a metric that passed every deterministic check (parse/bind/type/dry-run/temporality)
    // is upgraded to `llm-validated`. Without a dry-run we can't certify it — it stays `llm`.
    if (dryRanFormulas) {
      const failedSubjects = new Set(validationErrors.map((e) => e.subject));
      for (const n of ontology['@graph']) {
        if (n['@type'] !== 'qsl:Capability' || n['qsl:kind'] !== 'metric') continue;
        if (n['qsl:provenance'] !== 'llm' || !n['qsl:formulaHint'] || failedSubjects.has(n['@id'])) continue;
        n['qsl:provenance'] = 'llm-validated';
        n['qsl:validationEvidence'] = ['parse', 'bind', 'type', 'dry-run', 'temporality'];
      }
    }

    return { ontology, validationErrors };
  };
}
