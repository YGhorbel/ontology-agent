/**
 * Regenerate-and-DIFF blast-radius guard (ADR-015).
 *
 * Proves the freeze+diff mechanism: after freezing LLM free-text + capabilities from the prior
 * artifact, a regenerated artifact differs from the old one ONLY by the new temporality tags, even
 * when the fresh run resampled every description, altLabel, and capability identity.
 */
import { describe, it, expect } from 'vitest';
import { freezeLlmFields, diffArtifacts } from '../../src/serialize/artifact-merge.js';

const oldArtifact = {
  '@context': { qsl: 'q#' },
  'qsl:ontology': { '@id': 'qsl:ontology', '@type': 'owl:Ontology', 'dcterms:created': '2026-01-01' },
  '@graph': [
    {
      '@id': 'qsl:property/driverstandings/position',
      '@type': 'owl:DatatypeProperty',
      'rdfs:label': 'Standing position',
      'rdfs:comment': "Driver's place in the championship standings as-of the race.",
      'skos:prefLabel': 'Standing position',
      'qsl:mapsToColumn': 'position',
      'qsl:dataType': 'bigint',
      // NOTE: no temporality tag in the old artifact — this is the tag-gap being closed.
    },
    {
      '@id': 'qsl:capability/metric/orders/revenue',
      '@type': 'qsl:Capability',
      'skos:prefLabel': 'Revenue',
      'qsl:formulaHint': 'SUM(total_amount)',
    },
  ],
};

// A fresh regeneration: the description + prefLabel resampled, the capability re-slugged to a new @id,
// AND the deterministic profiler attached the new temporality tag.
const freshArtifact = {
  '@context': { qsl: 'q#' },
  'qsl:ontology': { '@id': 'qsl:ontology', '@type': 'owl:Ontology', 'dcterms:created': '2026-06-28' },
  '@graph': [
    {
      '@id': 'qsl:property/driverstandings/position',
      '@type': 'owl:DatatypeProperty',
      'rdfs:label': 'Championship position', // ← LLM drift
      'rdfs:comment': 'The position the driver holds in the standings.', // ← LLM drift
      'skos:prefLabel': 'Championship position', // ← LLM drift
      'qsl:mapsToColumn': 'position',
      'qsl:dataType': 'bigint',
      'qsl:temporality': 'as-of-event-snapshot', // ← the intended new tag
      'qsl:temporalityEvidence': { partitionColumns: ['driverid', 'year'], orderColumn: 'round', signal: 'carry-forward', vnRatio: 0.046 },
    },
    {
      '@id': 'qsl:capability/metric/orders/total-revenue', // ← capability @id drift
      '@type': 'qsl:Capability',
      'skos:prefLabel': 'Total revenue',
      'qsl:formulaHint': 'SUM(amount)',
    },
  ],
};

describe('freezeLlmFields + diffArtifacts', () => {
  it('after freeze, the ONLY diff vs the old artifact is the new temporality tags (0 other changes)', () => {
    const frozen = freezeLlmFields(freshArtifact, oldArtifact);
    const diff = diffArtifacts(oldArtifact, frozen);

    // Intended: the position column gained both temporality fields.
    const tagKeys = diff.tagChanges.map((c) => `${c.id} ${c.key}`).sort();
    expect(tagKeys).toEqual([
      'qsl:property/driverstandings/position qsl:temporality',
      'qsl:property/driverstandings/position qsl:temporalityEvidence',
    ]);
    // Blast radius: nothing else changed — description, prefLabel, and the drifted capability @id all
    // frozen back to the old artifact.
    expect(diff.otherChanges).toEqual([]);
  });

  it('WITHOUT freeze, the raw regeneration shows the LLM drift as other changes (the noise we suppress)', () => {
    const diff = diffArtifacts(oldArtifact, freshArtifact);
    expect(diff.otherChanges.length).toBeGreaterThan(0); // descriptions + capability add/remove leak through
    // The capability @id drift surfaces as one removed + one added node.
    expect(diff.otherChanges.some((c) => c.kind === 'removed')).toBe(true);
    expect(diff.otherChanges.some((c) => c.kind === 'added')).toBe(true);
  });
});
