/**
 * Regenerate-and-DIFF blast-radius report (ADR-015).
 *
 *   pnpm tsx scripts/temporality-diff.ts <old-artifact.jsonld> <new-artifact.jsonld>
 *
 * Measurement ONLY. Loads two ontology artifacts and reports, node-by-node (`@id`), the field
 * changes split into:
 *   - INTENDED: the new `qsl:temporality` / `qsl:temporalityEvidence` tags (list every column that
 *     gained/changed a tag);
 *   - OTHER: any non-temporality field change, or any added/removed node (target: 0 — proves the
 *     regeneration smuggled no description/capability drift into the next benchmark).
 *
 * The `qsl:ontology` build header (timestamp/knobs) is ignored — it legitimately changes every build.
 * Exits non-zero when OTHER changes are present so CI / a human notices unintended drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffArtifacts, formatDiff } from '../src/serialize/artifact-merge.js';

function main(): number {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('Usage: pnpm tsx scripts/temporality-diff.ts <old-artifact.jsonld> <new-artifact.jsonld>');
    return 2;
  }
  const base = JSON.parse(readFileSync(resolve(oldPath), 'utf8'));
  const next = JSON.parse(readFileSync(resolve(newPath), 'utf8'));
  const diff = diffArtifacts(base, next);

  console.log(`old: ${oldPath}`);
  console.log(`new: ${newPath}`);
  console.log(formatDiff(diff));

  if (diff.otherChanges.length > 0) {
    console.error(`\nFAIL: ${diff.otherChanges.length} unintended change(s) — regeneration drifted beyond the temporality tags.`);
    return 1;
  }
  console.log(`\nOK: ${diff.tagChanges.length} intended tag change(s), 0 unintended changes.`);
  return 0;
}

process.exit(main());
