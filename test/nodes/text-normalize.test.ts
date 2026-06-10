import { describe, it, expect } from 'vitest';
import {
  normalize,
  tokenize,
  rawTokens,
  singularize,
  spans,
  damerauLevenshtein,
  similarity,
  trigramSim,
  isCue,
  directionFor,
} from '../../src/query/text-normalize.js';

describe('normalize', () => {
  it('lowercases, strips punctuation and diacritics, collapses whitespace', () => {
    expect(normalize('  Total   Points! ')).toBe('total points');
    expect(normalize('Citroën / Förmula-1')).toBe('citroen formula 1');
  });
});

describe('singularize', () => {
  it('handles regular and -ies/-ses plurals', () => {
    expect(singularize('races')).toBe('race');
    expect(singularize('companies')).toBe('company');
    expect(singularize('buses')).toBe('bus');
  });
  it('leaves -ss / -us words and short words alone', () => {
    expect(singularize('status')).toBe('status');
    expect(singularize('class')).toBe('class');
    expect(singularize('bus')).toBe('bus');
  });
});

describe('tokenize / rawTokens', () => {
  it('tokenize drops stopwords and singularizes', () => {
    expect(tokenize('total points for the drivers')).toEqual(['total', 'point', 'driver']);
  });
  it('rawTokens keeps cue words and does not singularize', () => {
    expect(rawTokens('revenue by orders')).toEqual(['revenue', 'by', 'orders']);
    expect(isCue('by')).toBe(true);
  });
});

describe('spans', () => {
  it('produces all 1..n-gram contiguous spans', () => {
    expect(spans(['a', 'b', 'c'], 2)).toEqual(['a', 'a b', 'b', 'b c', 'c']);
  });
});

describe('damerauLevenshtein / similarity', () => {
  it('counts a single transposition as distance 1', () => {
    expect(damerauLevenshtein('ferrari', 'ferrari')).toBe(0);
    expect(damerauLevenshtein('ferrari', 'ferarri')).toBe(1);
  });
  it('similarity tolerates a one-character typo above 0.8', () => {
    expect(similarity('ferrari', 'ferarri')).toBeGreaterThan(0.82);
    expect(similarity('points', 'pointz')).toBeGreaterThan(0.82);
    expect(similarity('points', 'circuit')).toBeLessThan(0.5);
  });
});

describe('trigramSim', () => {
  it('is 1 for identical strings and higher for closer phrases', () => {
    expect(trigramSim('revenue', 'revenue')).toBe(1);
    expect(trigramSim('revenue', 'revenu')).toBeGreaterThan(trigramSim('revenue', 'currency'));
  });
});

describe('directionFor', () => {
  it('uses the map verbatim for unambiguous superlatives', () => {
    expect(directionFor('highest', 'points')).toBe('desc');
    expect(directionFor('lowest', 'points')).toBe('asc');
  });
  it('flips polarity-ambiguous words by the metric: speed-like → fastest is desc', () => {
    expect(directionFor('fastest', 'fastest lap speed')).toBe('desc');
    expect(directionFor('slowest', 'top speed')).toBe('asc');
  });
  it('time-like metric: fastest is asc (smallest time)', () => {
    expect(directionFor('fastest', 'lap time')).toBe('asc');
    expect(directionFor('slowest', 'duration')).toBe('desc');
  });
  it('falls back to the time-like default when the metric is unclassified', () => {
    expect(directionFor('fastest', 'driver')).toBe('asc');
  });
});
