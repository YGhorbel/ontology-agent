/**
 * Golden schema-linking fixtures: two self-contained ontologies (an f1-like and an
 * ecommerce-like one) built in-memory via assembleOntology — faithful to the real
 * generated labels but CI-safe (the `out/` ontologies are gitignored).
 *
 * Each golden case states the *stable* essentials of the expected QueryIntent
 * (which tables / measures / filters / group dims / ambiguities / unresolved),
 * not exact scores, so the assertions survive threshold tuning.
 */
import { assembleOntology } from '../../src/agent/assemble.js';
import { buildOntologyIndex, type OntologyIndex } from '../../src/query/ontology-index.js';
import { classIri, type Capability, type ConceptCandidate, type Relationship } from '../../src/types/ontology.js';
import type { ColumnFact } from '../../src/types/column-fact.js';

const cls = (table: string, prefLabel: string, altLabel: string[] = []): ConceptCandidate => ({
  source: { table },
  ontologyKind: 'Class',
  prefLabel,
  altLabel,
  rdfsLabel: prefLabel,
  rdfsComment: prefLabel,
});
const prop = (table: string, column: string, prefLabel: string, altLabel: string[] = []): ConceptCandidate => ({
  source: { table, column },
  ontologyKind: 'DatatypeProperty',
  prefLabel,
  altLabel,
  rdfsLabel: prefLabel,
  rdfsComment: prefLabel,
});
const fact = (table: string, column: string, o: Partial<ColumnFact> = {}): ColumnFact => ({
  table,
  column,
  dataType: 'text',
  isNumericText: false,
  isUnique: false,
  isPrimaryKey: false,
  distinctCount: null,
  nullable: false,
  sampleValues: [],
  ...o,
});
const metric = (
  table: string,
  column: string,
  prefLabel: string,
  altLabel: string[] = [],
  formulaHint?: string,
  preferredDirection?: 'higher' | 'lower',
): Capability => ({
  kind: 'metric',
  scope: { class: classIri(table), property: column },
  prefLabel,
  altLabel,
  provenance: 'llm',
  ...(formulaHint ? { formulaHint } : {}),
  ...(preferredDirection ? { preferredDirection } : {}),
});
const dimension = (table: string, column: string, prefLabel: string, altLabel: string[] = []): Capability => ({
  kind: 'dimension',
  scope: { class: classIri(table), property: column },
  prefLabel,
  altLabel,
  provenance: 'llm',
});
const factTable = (table: string, prefLabel: string): Capability => ({
  kind: 'factTable',
  scope: { class: classIri(table) },
  prefLabel,
  altLabel: [],
  provenance: 'llm',
});
const objProp = (from: string, to: string, fk: string): Relationship => ({
  kind: 'objectProperty',
  source: { class: classIri(from) },
  target: { class: classIri(to) },
  predicate: fk,
  cardinality: 'one-to-many',
  provenance: 'declared',
  confidence: 1,
  junctionTable: null,
  joinColumns: { from: fk, to: fk },
  derivedFrom: { table: from, foreignKey: `${from}_${fk}_fkey` },
});

// --- f1-like ontology (subset mirroring the real generated labels) ---
function buildF1(): OntologyIndex {
  const concepts: ConceptCandidate[] = [
    cls('results', 'Race result', ['Result', 'Race outcome']),
    cls('constructors', 'Constructor', ['team', 'racing team']),
    cls('drivers', 'Driver', ['Racing driver', 'Competitor']),
    cls('driverstandings', 'Driver Standing', ['Driver ranking']),
    cls('races', 'Race', ['Grand Prix', 'race event']),
    cls('seasons', 'Formula One season', ['Season', 'F1 season']),
    cls('qualifying', 'Qualifying result', ['Qualifying', 'Qualifier']),
    prop('qualifying', 'qualifyid', 'Qualifying ID', []),
    prop('qualifying', 'raceid', 'Race', []),
    prop('qualifying', 'driverid', 'Driver', []),
    prop('qualifying', 'q1', 'Q1 time', ['first qualifying time', 'Q1']),
    prop('drivers', 'driverref', 'Driver reference', ['ref', 'driver slug']),
    prop('results', 'points', 'Points', ['race points']),
    prop('results', 'fastestlapspeed', 'Fastest lap speed', ['top speed']),
    prop('results', 'milliseconds', 'Lap time', ['race time']),
    prop('results', 'position', 'Finishing position', ['Finish position']),
    prop('results', 'constructorid', 'Constructor', []),
    prop('results', 'driverid', 'Driver', []),
    prop('results', 'raceid', 'Race', []),
    prop('driverstandings', 'position', 'Position', ['rank']),
    prop('driverstandings', 'driverid', 'Driver', []),
    prop('constructors', 'constructorid', 'Constructor ID', []),
    prop('constructors', 'name', 'Constructor name', ['team name']),
    prop('constructors', 'nationality', 'Nationality', ['country']),
    prop('drivers', 'driverid', 'Driver ID', []),
    prop('drivers', 'surname', 'Family name', ['last name']),
    prop('races', 'raceid', 'Race ID', []),
    prop('races', 'year', 'season year', ['year']),
  ];
  const facts: ColumnFact[] = [
    fact('results', 'points', { dataType: 'integer' }),
    fact('results', 'fastestlapspeed', { dataType: 'numeric' }),
    fact('results', 'milliseconds', { dataType: 'bigint' }),
    fact('results', 'position', { dataType: 'bigint' }),
    fact('driverstandings', 'position', { dataType: 'bigint' }),
    fact('constructors', 'constructorid', { dataType: 'bigint', isPrimaryKey: true, isUnique: true }),
    fact('constructors', 'nationality', { dataType: 'text', distinctCount: 3, sampleValues: ['British', 'German', 'Italian'] }),
    fact('races', 'year', { dataType: 'integer' }),
    fact('races', 'raceid', { dataType: 'bigint', isPrimaryKey: true, isUnique: true }),
    fact('drivers', 'driverid', { dataType: 'bigint', isPrimaryKey: true, isUnique: true }),
    fact('qualifying', 'qualifyid', { dataType: 'bigint', isPrimaryKey: true, isUnique: true }),
    fact('qualifying', 'q1', { dataType: 'text' }),
    fact('drivers', 'driverref', { dataType: 'text' }),
  ];
  const caps: Capability[] = [
    metric('results', 'points', 'points', ['race points', 'scoring points'], 'SUM(results.points)', 'higher'),
    metric('results', 'fastestlapspeed', 'fastest lap speed', ['top speed'], 'AVG(CAST(results.fastestlapspeed AS REAL))', 'higher'),
    metric('results', 'milliseconds', 'lap time', ['race time'], 'AVG(results.milliseconds)', 'lower'),
    metric('races', 'raceid', 'number of races', ['race count'], 'COUNT(races.raceid)', 'higher'),
    factTable('results', 'Race results (fact table)'),
    dimension('drivers', 'driverid', 'Driver', ['racer']),
    dimension('constructors', 'constructorid', 'Constructor', ['team']),
  ];
  const rels: Relationship[] = [
    objProp('results', 'constructors', 'constructorid'),
    objProp('results', 'drivers', 'driverid'),
    objProp('results', 'races', 'raceid'),
    objProp('driverstandings', 'drivers', 'driverid'),
    objProp('qualifying', 'races', 'raceid'),
    objProp('qualifying', 'drivers', 'driverid'),
  ];
  return buildOntologyIndex(assembleOntology(concepts, rels, caps, facts));
}

// --- ecommerce-like ontology ---
function buildEcommerce(): OntologyIndex {
  const concepts: ConceptCandidate[] = [
    cls('customers', 'Customer', ['Shopper', 'Buyer', 'Client']),
    cls('orders', 'Order', ['Purchase', 'Sales order']),
    cls('line_items', 'Order Line Item', ['Line Item', 'Order line']),
    cls('refunds', 'Refund', ['Return payment']),
    prop('orders', 'id', 'Order ID', []),
    prop('orders', 'total_amount', 'Order Total', ['amount']),
    prop('orders', 'currency', 'Currency', ['currency code']),
    prop('orders', 'customer_id', 'Customer ID', []),
    prop('customers', 'id', 'Customer ID', []),
    prop('customers', 'status', 'Lifecycle status', ['status']),
    prop('line_items', 'quantity', 'Quantity', ['qty', 'units']),
  ];
  const facts: ColumnFact[] = [
    fact('orders', 'id', { dataType: 'integer', isPrimaryKey: true, isUnique: true }),
    fact('orders', 'total_amount', { dataType: 'numeric' }),
    fact('orders', 'currency', { dataType: 'text', distinctCount: 1, sampleValues: ['EUR'] }),
    fact('customers', 'id', { dataType: 'integer', isPrimaryKey: true, isUnique: true }),
    fact('customers', 'status', { dataType: 'text', distinctCount: 2, sampleValues: ['active', 'churned'] }),
    fact('line_items', 'quantity', { dataType: 'integer' }),
  ];
  const caps: Capability[] = [
    metric('orders', 'total_amount', 'revenue', ['turnover', 'sales', 'top-line'], 'SUM(orders.total_amount)', 'higher'),
    metric('orders', 'id', 'order count', ['number of orders'], 'COUNT(orders.id)', 'higher'),
    factTable('orders', 'Order (fact table)'),
    dimension('customers', 'id', 'Customer (dimension)', ['clients']),
  ];
  const rels: Relationship[] = [
    objProp('orders', 'customers', 'customer_id'),
    objProp('line_items', 'orders', 'order_id'),
  ];
  return buildOntologyIndex(assembleOntology(concepts, rels, caps, facts));
}

export const f1Index = buildF1();
export const ecommerceIndex = buildEcommerce();

export interface GoldenCase {
  question: string;
  index: OntologyIndex;
  /** Optional BIRD-style evidence string (parsed deterministically into hints). */
  evidence?: string;
  /** Tables that must all appear in intent.tables. */
  tables?: string[];
  /** "table.column" projection (SELECT) columns that must appear. */
  projection?: string[];
  /** "table.column" measures that must appear. */
  measures?: string[];
  /** "table.column=value" filters that must appear (value normalized lowercase). */
  filters?: string[];
  /** "table.column" group dimensions that must appear. */
  groupDims?: string[];
  /** "table.column dir" order-by terms that must appear. */
  orderBy?: string[];
  /** Expected LIMIT. */
  limit?: number;
  /** Spans that must be flagged ambiguous. */
  ambiguous?: string[];
  /** Tokens that must appear in unresolved. */
  unresolved?: string[];
  /** When true, assert intent.ambiguities is empty. */
  unambiguous?: boolean;
}

export const goldenCases: GoldenCase[] = [
  // f1 — measure + value-dictionary filter
  {
    question: 'total points for British constructors',
    index: f1Index,
    tables: ['results', 'constructors'],
    measures: ['results.points'],
    filters: ['constructors.nationality=british'],
  },
  // f1 — multi-word metric label + entity
  {
    question: 'number of races per season',
    index: f1Index,
    tables: ['races'],
    measures: ['races.raceid'],
  },
  // f1 — genuine collision: "position" lives on several tables → surfaced as ambiguous
  {
    question: 'show position',
    index: f1Index,
    ambiguous: ['position'],
  },
  // f1 — nonsense token must surface, not be silently absorbed
  {
    question: 'average wibblefrotz by team',
    index: f1Index,
    unresolved: ['wibblefrotz'],
    measures: [],
  },
  // ecommerce — same linker, different schema, no code change (generality)
  {
    question: 'revenue for active customers',
    index: ecommerceIndex,
    tables: ['orders', 'customers'],
    measures: ['orders.total_amount'],
    filters: ['customers.status=active'],
  },
  // ecommerce — group-by on a named column dimension
  {
    question: 'order count by currency',
    index: ecommerceIndex,
    tables: ['orders'],
    measures: ['orders.id'],
    groupDims: ['orders.currency'],
  },
  // f1 — BIRD #846 WITH evidence: projection + numeric filter + order/limit resolve deterministically
  {
    question: 'list the reference names of the drivers eliminated in the first period in race number 20',
    index: f1Index,
    evidence:
      'driver reference name refers to driverRef; first qualifying period refers to q1; ' +
      'drivers eliminated in the first qualifying period refers to 5 drivers with MAX(q1); ' +
      'race number refers to raceId',
    projection: ['drivers.driverref'],
    filters: ['races.raceid=20'],
    orderBy: ['qualifying.q1 desc'],
    limit: 5,
    unresolved: ['eliminated'],
  },
  // f1 — BIRD #846 WITHOUT evidence: the knowledge-only terms stay unresolved, no phantom measure
  {
    question: 'list the reference names of the drivers eliminated in the first period in race number 20',
    index: f1Index,
    measures: [],
    unresolved: ['eliminated', 'period'],
  },
  // f1 — Sprint 3b: ranking context ("the X with the fastest Y") ⇒ ORDER BY + LIMIT 1,
  // NOT an aggregate. fastestLapSpeed reads as speed-like, so "fastest" sorts DESC.
  {
    question: 'what is the family name of the driver with the fastest lap speed',
    index: f1Index,
    tables: ['results', 'drivers'],
    projection: ['drivers.surname'],
    measures: [],
    orderBy: ['results.fastestlapspeed desc'],
    limit: 1,
  },
];
