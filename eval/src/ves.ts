/**
 * Reward-based Valid Efficiency Score (R-VES) — faithful port of bird-bench/mini_dev
 * `evaluation_ves.py`. R-VES rewards a correct candidate for being FASTER than the gold:
 * the reward is a step function of the time ratio `gold_time / candidate_time`, and is
 * ZERO unless the candidate is execution-correct (EX). The run-level score is
 * `mean( sqrt(reward) * 100 )` over all items.
 *
 * IMPORTANT: a meaningful R-VES needs the candidate and gold executed against the REAL
 * database over several iterations (timing is noisy); the official harness uses ~100 and
 * drops outliers. The runner captures single-shot gold/candidate execution times, which is
 * enough to compute R-VES but is noisy — treat R-VES as indicative until run with
 * iterations against the live DBs. On synthetic fixtures it is a placeholder.
 */
import type { RunRecord } from './types.js';

/**
 * Reward for a time ratio (gold_time / candidate_time), gated on correctness by the caller.
 * Faithful to mini_dev's thresholds:
 *   ratio == 0            → 0     (used to signal "incorrect / not timed")
 *   ratio >= 2            → 1.25
 *   1 <= ratio < 2        → 1
 *   0.5 <= ratio < 1      → 0.75
 *   0.25 <= ratio < 0.5   → 0.5
 *   else (0 < ratio<0.25) → 0.25
 */
export function vesReward(timeRatio: number): number {
  if (timeRatio === 0) return 0;
  if (timeRatio >= 2) return 1.25;
  if (timeRatio >= 1) return 1;
  if (timeRatio >= 0.5) return 0.75;
  if (timeRatio >= 0.25) return 0.5;
  return 0.25;
}

/**
 * Per-item reward: 0 unless the item is execution-correct (official R-VES gates on EX),
 * otherwise `vesReward(goldExecMs / candExecMs)`. Records without separate exec timings,
 * or with a non-positive candidate time, contribute reward 0.
 */
export function rewardForRecord(r: RunRecord): number {
  if (!r.executionMatchStrict) return 0;
  const gold = r.goldExecMs;
  const cand = r.candExecMs;
  if (gold === undefined || cand === undefined || cand <= 0 || gold <= 0) return 0;
  return vesReward(gold / cand);
}

/** Run-level R-VES = mean over items of sqrt(reward)*100. Matches `compute_ves`. */
export function computeRVES(records: RunRecord[]): number {
  if (records.length === 0) return 0;
  const total = records.reduce((s, r) => s + Math.sqrt(rewardForRecord(r)) * 100, 0);
  return total / records.length;
}
