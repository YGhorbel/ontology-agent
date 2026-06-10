import { describe, it, expect } from 'vitest';
import { buildLinkTargets } from '../../src/query/link-surface.js';
import { f1Index } from '../fixtures/golden-questions.js';

describe('buildLinkTargets', () => {
  const targets = buildLinkTargets(f1Index);
  const find = (table: string, column?: string, kind?: string) =>
    targets.filter(
      (t) => t.ref.table === table && t.ref.column === column && (kind ? t.kind === kind : true),
    );

  it('emits class, column, and capability targets', () => {
    expect(targets.some((t) => t.kind === 'class')).toBe(true);
    expect(targets.some((t) => t.kind === 'column')).toBe(true);
    expect(targets.some((t) => t.kind === 'capability')).toBe(true);
  });

  it('includes altLabel synonyms in the normalized surfaces', () => {
    const constructors = find('constructors', undefined, 'class')[0];
    expect(constructors?.surfaces).toContain('team'); // skos:altLabel surfaced
    expect(constructors?.surfaces).toContain('constructor');
  });

  it('attaches a normalized value dictionary to categorical columns', () => {
    const nationality = find('constructors', 'nationality', 'column')[0];
    expect(nationality?.sampleValues).toEqual(['british', 'german', 'italian']);
    expect(nationality?.role).toBe('dimension'); // low-card non-key text
  });

  it('marks a metric column as a measure, not a dimension', () => {
    const points = find('results', 'points', 'column')[0];
    expect(points?.role).toBe('measure');
  });

  it('leaves a plain numeric column without a value dictionary as an attribute', () => {
    const position = find('results', 'position', 'column')[0];
    expect(position?.role).toBe('attribute');
    expect(position?.sampleValues).toEqual([]);
  });
});
