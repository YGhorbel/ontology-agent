/**
 * Render a generated ontology JSON-LD file to a Mermaid diagram.
 *
 *   npx tsx scripts/visualize.ts [path/to/ontology.jsonld]
 *
 * With no argument it picks the newest file in out/. Writes a .mmd next to the
 * source and (if `mmdc` is installed) an .svg you can open in the browser / VS Code.
 *
 * The graph shows classes as boxes, FK-derived object properties as labelled edges,
 * and capabilities (metrics/time grains/fact tables/dimensions) as rounded nodes
 * dotted-linked to the class they scope. Datatype-property counts are folded into
 * each class label to keep the diagram readable.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { OntologyJsonLdSchema, type GraphNode } from '../src/types/ontology.js';

/** Locate the puppeteer-managed chrome-headless-shell (installed once via `pnpm viz:setup`). */
function findChrome(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (!existsSync(base)) return undefined;
  for (const ver of readdirSync(base)) {
    const bin = join(base, ver, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

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

const sanitize = (iri: string): string => iri.replace(/[^a-zA-Z0-9]/g, '_');
const esc = (s: string): string => s.replace(/"/g, "'").replace(/\n/g, ' ');

function toMermaid(graph: GraphNode[]): string {
  const classes = graph.filter((n) => n['@type'] === 'owl:Class');
  const objectProps = graph.filter((n) => n['@type'] === 'owl:ObjectProperty');
  const datatypeProps = graph.filter((n) => n['@type'] === 'owl:DatatypeProperty');
  const caps = graph.filter((n) => n['@type'] === 'qsl:Capability');

  const propCount = new Map<string, number>();
  for (const p of datatypeProps) {
    if (p['@type'] !== 'owl:DatatypeProperty') continue;
    const dom = p['rdfs:domain']['@id'];
    propCount.set(dom, (propCount.get(dom) ?? 0) + 1);
  }

  const lines: string[] = ['graph LR'];

  // Class nodes.
  for (const c of classes) {
    if (c['@type'] !== 'owl:Class') continue;
    const n = propCount.get(c['@id']) ?? 0;
    lines.push(`  ${sanitize(c['@id'])}["${esc(c['skos:prefLabel'])}<br/><small>${n} properties</small>"]`);
  }

  // Object-property edges.
  for (const o of objectProps) {
    if (o['@type'] !== 'owl:ObjectProperty') continue;
    const label = `${esc(o['rdfs:label'])} (${o['qsl:cardinality']})`;
    lines.push(`  ${sanitize(o['rdfs:domain']['@id'])} -->|"${label}"| ${sanitize(o['rdfs:range']['@id'])}`);
  }

  // Capability nodes, dotted-linked to their scope class.
  const icon: Record<string, string> = { metric: '📊', timeGrain: '🕒', factTable: '⭐', dimension: '🧭' };
  for (const cap of caps) {
    if (cap['@type'] !== 'qsl:Capability') continue;
    const id = sanitize(cap['@id']);
    const label = cap['skos:prefLabel'] ?? cap['qsl:kind'];
    const detail = cap['qsl:formulaHint'] ? `<br/><small>${esc(cap['qsl:formulaHint'])}</small>` : '';
    lines.push(`  ${id}(["${icon[cap['qsl:kind']] ?? ''} ${esc(label)}${detail}"])`);
    lines.push(`  ${id} -.-> ${sanitize(cap['qsl:scopeClass'])}`);
  }

  // A little styling.
  lines.push('  classDef cap fill:#eef,stroke:#88a,color:#114;');
  const capIds = caps.map((c) => sanitize(c['@id']));
  if (capIds.length > 0) lines.push(`  class ${capIds.join(',')} cap;`);

  return lines.join('\n');
}

function main(): void {
  const src = process.argv[2] ? resolve(process.argv[2]) : latestJsonld();
  const ontology = OntologyJsonLdSchema.parse(JSON.parse(readFileSync(src, 'utf8')));
  const mermaid = toMermaid(ontology['@graph']);

  const mmdPath = join(dirname(src), basename(src).replace(/\.jsonld$/, '.mmd'));
  writeFileSync(mmdPath, mermaid, 'utf8');
  console.log(`Mermaid written to: ${mmdPath}`);

  const svgPath = mmdPath.replace(/\.mmd$/, '.svg');
  const chrome = findChrome();
  try {
    const cfg = join(mkdtempSync(join(tmpdir(), 'pptr-')), 'config.json');
    writeFileSync(cfg, JSON.stringify({ args: ['--no-sandbox', '--disable-gpu'] }));
    execFileSync('mmdc', ['-i', mmdPath, '-o', svgPath, '-b', 'white', '-p', cfg], {
      stdio: 'pipe',
      env: { ...process.env, ...(chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {}) },
    });
    console.log(`SVG rendered to:    ${svgPath}`);
    console.log('Open the .svg in your browser or VS Code to view the graph.');
  } catch (err) {
    const hint = chrome
      ? `mmdc failed: ${err instanceof Error ? err.message : String(err)}`
      : 'No headless Chrome found. Run `pnpm viz:setup` once, then re-run.';
    console.log(`${hint}\nMeanwhile, paste the .mmd contents into https://mermaid.live to view.`);
  }
}

main();
