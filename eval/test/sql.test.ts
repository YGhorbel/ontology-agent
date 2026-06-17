import { describe, it, expect } from 'vitest';
import { extractJoinPairs, goldHasTopLevelOrderBy } from '../src/sql.js';
import { joinPathPRF } from '../src/metrics.js';
import { SYNTHETIC } from '../src/fixtures-synthetic.js';

describe('goldHasTopLevelOrderBy (orderMatters derivation)', () => {
  it('true only for a top-level ORDER BY', () => {
    expect(goldHasTopLevelOrderBy('SELECT a FROM t ORDER BY a')).toBe(true);
    expect(goldHasTopLevelOrderBy('SELECT a FROM t')).toBe(false);
  });
  it('ORDER BY inside a subquery does not make the result ordered', () => {
    expect(goldHasTopLevelOrderBy('SELECT a FROM (SELECT a FROM t ORDER BY a) s')).toBe(false);
  });
  it('unparseable gold defaults to false (set comparison)', () => {
    expect(goldHasTopLevelOrderBy('SELECT FROM WHERE')).toBe(false);
  });
});

// Representative join SQLs with their expected canonical pair sets.
const JOIN_SQL: Array<{ name: string; sql: string; expect: string[] }> = [
  {
    name: 'explicit JOIN ON with aliases',
    sql: 'SELECT * FROM results r JOIN drivers d ON r.driverid = d.driverid',
    expect: ['drivers.driverid=results.driverid'],
  },
  {
    name: 'WHERE-clause join predicate',
    sql: 'SELECT * FROM results r, drivers d WHERE r.driverid = d.driverid',
    expect: ['drivers.driverid=results.driverid'],
  },
  {
    name: 'two-hop join',
    sql: 'SELECT * FROM a JOIN b ON a.bid = b.id JOIN c ON b.cid = c.id',
    expect: ['a.bid=b.id', 'b.cid=c.id'],
  },
  {
    name: 'no joins',
    sql: 'SELECT name FROM drivers ORDER BY wins DESC',
    expect: [],
  },
];

describe('extractJoinPairs', () => {
  for (const j of JOIN_SQL) {
    it(`${j.name} → ${JSON.stringify(j.expect)}`, () => {
      expect([...extractJoinPairs(j.sql)].sort()).toEqual([...j.expect].sort());
    });
  }
  it('alias direction is symmetric (a.x=b.y == b.y=a.x)', () => {
    const p1 = extractJoinPairs('SELECT * FROM a JOIN b ON a.x = b.y');
    const p2 = extractJoinPairs('SELECT * FROM b JOIN a ON b.y = a.x');
    expect([...p1]).toEqual([...p2]);
  });
});

describe('join-path P/R is 1.0 gold-vs-gold (the pre-Sprint-2 validation gate)', () => {
  for (const j of JOIN_SQL) {
    it(`${j.name}`, () => {
      const prf = joinPathPRF(j.sql, j.sql);
      expect(prf.precision).toBe(1);
      expect(prf.recall).toBe(1);
      expect(prf.f1).toBe(1);
    });
  }
  it('every synthetic gold scores precision=recall=1.0 against itself', () => {
    for (const item of SYNTHETIC) {
      const prf = joinPathPRF(item.gold.goldSql, item.gold.goldSql);
      expect(prf.precision).toBe(1);
      expect(prf.recall).toBe(1);
    }
  });
  it('a missing join edge drops recall below 1 (extractor discriminates)', () => {
    const gold = 'SELECT * FROM a JOIN b ON a.bid = b.id JOIN c ON b.cid = c.id';
    const cand = 'SELECT * FROM a JOIN b ON a.bid = b.id'; // missing b-c edge
    const prf = joinPathPRF(cand, gold);
    expect(prf.recall).toBeCloseTo(0.5, 10);
    expect(prf.precision).toBe(1);
  });
});
