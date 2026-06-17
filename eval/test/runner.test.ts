import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSystem } from '../src/runner.js';
import { aggregate, loadRunHeader, loadRunRecords } from '../src/metrics.js';
import { SYNTHETIC, makeFakeDb, makeSyntheticSystem } from '../src/fixtures-synthetic.js';
import type { RunRecord } from '../src/types.js';

const runsDir = mkdtempSync(join(tmpdir(), 'eval-runs-'));
afterAll(() => rmSync(runsDir, { recursive: true, force: true }));

const gold = SYNTHETIC.map((s) => s.gold);

async function doRun(startedAtIso: string) {
  return runSystem(makeSyntheticSystem(), gold, {
    set: 'synthetic',
    system: 'fixture-system',
    openDb: async () => makeFakeDb(),
    runsDir,
    startedAtIso,
    knobs: { exampleKnob: 1 },
  });
}

describe('runner end-to-end (offline, fake DB + fake System)', () => {
  it('scores each item as the fixture predicts and persists JSONL + header', async () => {
    const out = await doRun('2026-06-17T00:00:00.000Z');

    // one record per gold item, in order
    expect(out.records).toHaveLength(SYNTHETIC.length);
    for (let i = 0; i < SYNTHETIC.length; i += 1) {
      const rec = out.records[i] as RunRecord;
      const fix = SYNTHETIC[i]!;
      expect(rec.id).toBe(fix.gold.id);
      expect(rec.executionMatch).toBe(fix.expectExecutionMatch);
      expect(rec.executionMatchStrict).toBe(fix.expectStrict);
      expect(typeof rec.softF1).toBe('number');
      if (fix.expectNumeric !== undefined) {
        expect(rec.numericCorrectness).toBe(fix.expectNumeric);
      }
    }

    // the two documented divergences are present in the run
    const s5 = out.records.find((r) => r.id === 's5')!; // text-vs-numeric cast
    expect(s5.executionMatch).toBe(true);
    expect(s5.executionMatchStrict).toBe(false);
    const s7 = out.records.find((r) => r.id === 's7')!; // right rows, wrong order
    expect(s7.executionMatch).toBe(false);
    expect(s7.executionMatchStrict).toBe(true);

    // the deliberately broken candidate (s6) is captured as an error, not a crash
    const errRec = out.records.find((r) => r.id === 's6')!;
    expect(errRec.error).toBeTruthy();
    expect(errRec.executionMatch).toBe(false);

    // JSONL is readable and matches the in-memory records; header sidecar is present
    const onDisk = loadRunRecords(out.jsonlPath);
    expect(onDisk).toHaveLength(SYNTHETIC.length);
    const header = loadRunHeader(out.jsonlPath);
    expect(header?.set).toBe('synthetic');
    expect(header?.modelString).toBe('none');
    expect(header?.promptVersion).toBe('none');
    expect(header?.ontologies[0]?.buildNumber).toBeNull(); // no ontology supplied
    expect(header?.gitSha).toBeTruthy();
  });

  it('NEVER overwrites an existing run file (same timestamp → throws)', async () => {
    const ts = '2026-06-17T11:11:11.000Z';
    await doRun(ts);
    await expect(doRun(ts)).rejects.toThrow(); // wx flag refuses to clobber
  });

  it('aggregate computes EX accuracy, numeric%, per-stratum and tokens-per-correct', async () => {
    const out = await doRun('2026-06-17T22:22:22.000Z');
    const rep = aggregate(out.records, out.header);

    const expectedPlus = SYNTHETIC.filter((s) => s.expectExecutionMatch).length;
    const expectedStrict = SYNTHETIC.filter((s) => s.expectStrict).length;
    expect(rep.n).toBe(SYNTHETIC.length);
    expect(rep.executionAccuracy).toBeCloseTo(expectedPlus / SYNTHETIC.length, 10); // EX+
    expect(rep.executionAccuracyStrict).toBeCloseTo(expectedStrict / SYNTHETIC.length, 10); // BIRD EX
    // s5 and s7 disagree between strict and EX+
    expect(rep.strictVsPlusDisagreements).toBe(2);
    expect(rep.softF1Mean).toBeGreaterThanOrEqual(0);
    expect(rep.errors).toBe(1); // s6
    expect(rep.totalTokens).toBe(SYNTHETIC.length * 15); // 10 prompt + 5 completion each
    expect(rep.tokensPerCorrect).toBeCloseTo((SYNTHETIC.length * 15) / expectedStrict, 6);

    // numeric stratum has two numeric-gold items (s3 ok, s4 wrong) → 50%
    const agg = rep.perStratum.find((s) => s.stratum === 'aggregate')!;
    expect(agg.numericApplicable).toBe(2);
    expect(agg.numericCorrectness).toBeCloseTo(0.5, 10);
  });
});
