import { describe, it, expect } from 'vitest';
import { parseEvidence } from '../../src/query/evidence.js';
import { f1Index, ecommerceIndex } from '../fixtures/golden-questions.js';

describe('parseEvidence', () => {
  it('parses "<phrase> refers to <col>" into aliases (preferring a primary key)', () => {
    const { hints } = parseEvidence('race number refers to raceId; driver reference name refers to driverRef', f1Index);
    const race = hints.aliases.find((a) => a.phrase === 'race number');
    const ref = hints.aliases.find((a) => a.phrase === 'driver reference name');
    expect(race?.ref).toEqual({ table: 'races', column: 'raceid' }); // races.raceid is the PK
    expect(ref?.ref).toEqual({ table: 'drivers', column: 'driverref' });
  });

  it('derives ORDER BY + LIMIT from a MAX(col) clause with an integer', () => {
    const { hints } = parseEvidence('drivers eliminated refers to 5 drivers with MAX(q1)', f1Index);
    expect(hints.orderBy).toEqual([{ column: 'q1', dir: 'desc' }]);
    expect(hints.limit).toBe(5);
  });

  it('uses ascending direction for MIN(col)', () => {
    const { hints } = parseEvidence('fastest refers to 3 with MIN(q1)', f1Index);
    expect(hints.orderBy[0]).toEqual({ column: 'q1', dir: 'asc' });
    expect(hints.limit).toBe(3);
  });

  it('parses the aggregate-before-column shape "(MAX) col"', () => {
    const { hints } = parseEvidence('1 driver with the (MAX) fastestlapspeed', f1Index);
    expect(hints.orderBy).toEqual([{ column: 'fastestlapspeed', dir: 'desc' }]);
    expect(hints.limit).toBe(1);
  });

  it('extracts a value illustration "<col> = \'value\'"', () => {
    const { hints } = parseEvidence("active customers means status = 'active'", ecommerceIndex);
    expect(hints.values.some((v) => v.value === 'active' && v.ref.column === 'status')).toBe(true);
  });

  it('drops clauses it cannot parse rather than guessing', () => {
    const { hints, dropped } = parseEvidence('this clause references nothing structured at all', f1Index);
    expect(hints.aliases).toHaveLength(0);
    expect(dropped.length).toBeGreaterThan(0);
  });
});
