/**
 * Regenerate-and-DIFF blast-radius control (ADR-015).
 *
 * Regenerating the ontology re-runs the two LLM nodes (concept-extract, capability-infer), whose
 * free-text (`rdfs:label`/`rdfs:comment`/`skos:prefLabel`/`skos:altLabel`) and capability set
 * (whose `@id` is itself derived from an LLM `prefLabel`) resample run-to-run. That noise would
 * swamp the one intended change — the new temporality tags — and confound the next benchmark (the
 * same LLM-noise confound the frozen-IR A/B was built to kill).
 *
 * `freezeLlmFields` carries the nondeterministic fields over from a prior artifact by `@id`, so the
 * fresh artifact differs from the old one ONLY by deterministic fields (structure + the new tags).
 * `diffArtifacts` then proves it: it splits every per-node field change into the INTENDED temporality
 * delta and ANY OTHER change (target: zero). The new artifact replaces the fixture only after the diff
 * confirms a minimal, intended delta — never a hand-edit.
 */

type JsonNode = Record<string, unknown> & { '@id': string; '@type'?: string };
type Artifact = Record<string, unknown> & { '@graph': JsonNode[] };

/** Free-text fields authored by the LLM concept/capability nodes — frozen across a regeneration. */
const LLM_TEXT_KEYS = ['rdfs:label', 'rdfs:comment', 'skos:prefLabel', 'skos:altLabel'] as const;
/** The intended delta of this brick — the only fields allowed to change on a frozen regeneration. */
export const TEMPORALITY_KEYS = ['qsl:temporality', 'qsl:temporalityEvidence'] as const;

const CAPABILITY_TYPE = 'qsl:Capability';

const byId = (nodes: JsonNode[]): Map<string, JsonNode> => {
  const m = new Map<string, JsonNode>();
  for (const n of nodes) m.set(n['@id'], n);
  return m;
};

/**
 * Return a copy of `fresh` whose nondeterministic fields are frozen to `frozenFrom`:
 *  - LLM free-text on matching nodes is overwritten to match the old node exactly (set old's values,
 *    drop keys the old node didn't have) so text resampling cannot show up in the diff;
 *  - the capability set is replaced wholesale by the old one (capability `@id`s are LLM-derived, so a
 *    fresh run can rename/re-slug them — wholesale freeze removes that identity drift).
 * Structure and the freshly-computed temporality tags are kept from `fresh`. Header/candidateGraph
 * pass through unchanged.
 */
export function freezeLlmFields<T extends Artifact>(fresh: T, frozenFrom: Artifact): T {
  const oldById = byId(frozenFrom['@graph']);
  const frozenGraph: JsonNode[] = [];

  for (const node of fresh['@graph']) {
    if (node['@type'] === CAPABILITY_TYPE) continue; // capabilities frozen wholesale below
    const old = oldById.get(node['@id']);
    if (!old) {
      frozenGraph.push(node);
      continue;
    }
    const merged: JsonNode = { ...node };
    for (const key of LLM_TEXT_KEYS) {
      if (key in old) merged[key] = old[key];
      else delete merged[key];
    }
    frozenGraph.push(merged);
  }

  // Append the old capability set verbatim (drop the fresh one entirely).
  for (const old of frozenFrom['@graph']) {
    if (old['@type'] === CAPABILITY_TYPE) frozenGraph.push(old);
  }

  return { ...fresh, '@graph': frozenGraph };
}

export interface TagChange {
  id: string;
  key: string;
  from: unknown;
  to: unknown;
}
export interface OtherChange {
  id: string;
  /** field key for a value change, or '(node)' for an added/removed node. */
  key: string;
  kind: 'changed' | 'added' | 'removed';
  from?: unknown;
  to?: unknown;
}
export interface ArtifactDiff {
  tagChanges: TagChange[];
  otherChanges: OtherChange[];
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isTemporalityKey = (k: string): boolean => (TEMPORALITY_KEYS as readonly string[]).includes(k);

/**
 * Node-by-node (`@id`) field diff of two artifacts, partitioned into intended temporality changes
 * vs any other change. Added/removed nodes and any non-temporality field change land in
 * `otherChanges` (the blast-radius signal; target zero on a frozen regeneration). The `@graph` and
 * any `qsl:candidateGraph` are compared together; the `qsl:ontology` build header is ignored
 * (its timestamp/knobs legitimately change every build).
 */
export function diffArtifacts(base: Artifact, next: Artifact): ArtifactDiff {
  const nodesOf = (a: Artifact): JsonNode[] => [
    ...a['@graph'],
    ...((a['qsl:candidateGraph'] as JsonNode[] | undefined) ?? []),
  ];
  const baseById = byId(nodesOf(base));
  const nextById = byId(nodesOf(next));

  const tagChanges: TagChange[] = [];
  const otherChanges: OtherChange[] = [];

  for (const [id, baseNode] of baseById) {
    if (!nextById.has(id)) otherChanges.push({ id, key: '(node)', kind: 'removed', from: baseNode['@type'] });
  }
  for (const [id, nextNode] of nextById) {
    const baseNode = baseById.get(id);
    if (!baseNode) {
      otherChanges.push({ id, key: '(node)', kind: 'added', to: nextNode['@type'] });
      continue;
    }
    const keys = new Set([...Object.keys(baseNode), ...Object.keys(nextNode)]);
    for (const key of keys) {
      if (key === '@id') continue;
      if (eq(baseNode[key], nextNode[key])) continue;
      if (isTemporalityKey(key)) tagChanges.push({ id, key, from: baseNode[key], to: nextNode[key] });
      else otherChanges.push({ id, key, kind: 'changed', from: baseNode[key], to: nextNode[key] });
    }
  }
  return { tagChanges, otherChanges };
}

/** One-line-per-change human summary for the CLI. */
export function formatDiff(diff: ArtifactDiff): string {
  const lines: string[] = [];
  lines.push(`Temporality tag changes (intended): ${diff.tagChanges.length}`);
  for (const c of diff.tagChanges) {
    const from = c.from === undefined ? '∅' : JSON.stringify(c.from);
    const to = c.to === undefined ? '∅' : JSON.stringify(c.to);
    lines.push(`  + ${c.id} ${c.key}: ${from} → ${to}`);
  }
  lines.push(`Other changes (must be 0): ${diff.otherChanges.length}`);
  for (const c of diff.otherChanges) {
    lines.push(`  ! ${c.id} ${c.key} [${c.kind}]`);
  }
  return lines.join('\n');
}
