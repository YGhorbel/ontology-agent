/**
 * Convert a generated ontology JSON-LD file to Turtle (.ttl).
 *
 *   npx tsx scripts/to-turtle.ts [path/to/ontology.jsonld]
 *
 * With no argument it converts the newest file in out/. Writes a .ttl next to the
 * source. Useful for loading the ontology into Protégé / WebVOWL / an RDF store.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { loadFullGraph } from '../src/query/ontology-index.js';
import { toTurtle } from '../src/serialize/turtle.js';

function latestJsonld(): string {
  const dir = resolve('out');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonld'))
    .map((f) => join(dir, f))
    .sort();
  const last = files[files.length - 1];
  if (!last) throw new Error('No .jsonld files in out/. Run the generator first.');
  return last;
}

function main(): void {
  const src = process.argv[2] ? resolve(process.argv[2]) : latestJsonld();
  const ontology = loadFullGraph(JSON.parse(readFileSync(src, 'utf8')));
  // Recover the datasource id from the filename: ontology-<id>-<timestamp>.jsonld
  const datasourceId = basename(src).replace(/^ontology-/, '').replace(/-\d{4}-\d{2}-\d{2}T.*$/, '') || 'datasource';
  const ttlPath = join(dirname(src), basename(src).replace(/\.jsonld$/, '.ttl'));
  writeFileSync(ttlPath, toTurtle(ontology, datasourceId), 'utf8');
  console.log(`Turtle written to: ${ttlPath}`);
}

main();
