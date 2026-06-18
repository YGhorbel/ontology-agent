/**
 * The `owl:Ontology` header (Fix 6): provenance + reproducibility metadata for one build.
 *
 * Carries a per-database base IRI, a semver+build `owl:versionInfo`, a `dcterms:created`
 * timestamp, a `qsl:sourceFingerprint` (a stable hash of DSN host+db+schema list — never
 * credentials), and the `ONTOLOGY_*` knob values used (threshold reproducibility). Pure:
 * all time/identity inputs are passed in, so it never reads the clock itself.
 */
import { createHash } from 'node:crypto';
import { QSL_BASE, type OntologyHeaderNode } from '../types/ontology.js';

/** Schema/shape version of the emitted ontology. Bumped for breaking output changes. */
export const QSL_SCHEMA_VERSION = 'qsl/v2';

/**
 * The `ONTOLOGY_*` knobs recorded in the header for reproducibility, each with the RESOLVED
 * default the pipeline actually applies when the env var is unset (Part 2c). These MUST match
 * the per-module `*FromEnv` fallbacks; a build records the concrete value used, never "default".
 */
const KNOB_DEFAULTS: Record<string, string> = {
  ONTOLOGY_IND_MIN_CONTAINMENT: '0.7',
  ONTOLOGY_NAME_MATCH_MIN: '1.0',
  ONTOLOGY_NAME_ONLY_CONFIDENCE: '0.65',
  ONTOLOGY_FK_MIN_SCORE: '0',
  ONTOLOGY_ENUM_MAX_DISTINCT: '50',
  ONTOLOGY_PROMPT_SAMPLE_VALUES: '15',
  ONTOLOGY_VALIDATE_DRY_RUN: 'true',
  ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS: '5000',
  ONTOLOGY_MONOTONIC_MIN_RATIO: '0.99',
  ONTOLOGY_EXPORT_MIN_CONF: '0.5',
  ONTOLOGY_CARDINALITY_MIN_CONF: '0.5',
  ONTOLOGY_COMPOSITE_MAX_ROWS: '5000000',
};

/**
 * Serialize the RESOLVED knob values as a flat string. When a knob is set in the environment
 * its explicit value is recorded; when unset, the applied default is recorded with a `(default)`
 * decoration so reproducibility never depends on knowing the generator's internal fallbacks.
 */
export function collectKnobs(env: NodeJS.ProcessEnv = process.env): string {
  return Object.entries(KNOB_DEFAULTS)
    .map(([k, def]) => `${k}=${env[k] !== undefined ? env[k] : `${def} (default)`}`)
    .join('; ');
}

/** Host+db identity of a DSN, credentials stripped. Falls back to the datasource id. */
function fingerprintSource(dsn: string, datasourceId: string, schemaList: string[]): string {
  let identity = datasourceId;
  try {
    const u = new URL(dsn);
    const db = u.pathname.replace(/^\//, '') || datasourceId;
    identity = `${u.hostname}:${u.port || '5432'}/${db}`;
  } catch {
    /* opaque DSN — fall back to the id */
  }
  return createHash('sha256').update(`${identity}/${schemaList.join(',')}`).digest('hex');
}

export interface OntologyHeaderInput {
  datasourceId: string;
  dsn: string;
  /** Schemas profiled (always `['public']` for now). */
  schemaList: string[];
  generatorVersion: string;
  /** Monotonic build number (e.g. epoch seconds, or ONTOLOGY_BUILD_NUMBER). */
  buildNumber: number;
  /** ISO-8601 build timestamp (passed in — the module never reads the clock). */
  createdIso: string;
  env?: NodeJS.ProcessEnv;
}

export function buildOntologyHeader(input: OntologyHeaderInput): OntologyHeaderNode {
  return {
    '@id': `${QSL_BASE}${input.datasourceId}`,
    '@type': 'owl:Ontology',
    'rdfs:label': `Semantic layer for datasource "${input.datasourceId}"`,
    'owl:versionInfo': `${QSL_SCHEMA_VERSION} generator ${input.generatorVersion} build ${input.buildNumber}`,
    'dcterms:created': input.createdIso,
    'qsl:sourceFingerprint': fingerprintSource(input.dsn, input.datasourceId, input.schemaList),
    'qsl:knobs': collectKnobs(input.env),
  };
}
