// walkForward — fold separation invariant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWalkForwardOnSeries } from "../walkForward";
import type { RunConfig } from "../types";
import type { OhlcvBar } from "../../engines/levels";

function makeBars(n: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / 30) % 4;
    const base = phase === 0 ? 100 : phase === 1 ? 105 : phase === 2 ? 100 : 95;
    bars.push({
      time: 1700000000 + i * 3600,
      open: base, close: base + (i % 2 ? 0.5 : -0.5),
      high: base + 1, low: base - 1, volume: 100,
    });
  }
  return bars;
}

const baseCfg = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  runId: "test", startedAt: 0, profile: "quick",
  symbols: ["TEST"], intervals: ["1h"], lookbackDays: 30,
  folds: 3, tpR: 1.5, slAtrMult: 1.0, timeoutBars: 12,
  feeBps: 5, slippageBps: 3,
  staleSampleMin: 30, moderateSampleMin: 100, headlineSampleMin: 300,
  engineConfigHash: "h", engineGitSha: "g", validationSuiteVersion: "v",
  ...overrides,
});

test("walkForward: fold train/test windows do NOT overlap", () => {
  const bars = makeBars(800);
  const r = runWalkForwardOnSeries({ symbol: "TEST", interval: "1h", bars, cfg: baseCfg({ folds: 4 }) });
  assert.ok(r.folds.length > 0, "expected at least one fold");
  for (const f of r.folds) {
    // Train window must end strictly before test starts.
    assert.ok(f.trainEnd < f.testStart || f.trainEnd === f.testStart,
      `fold ${f.fold}: trainEnd ${f.trainEnd} must be ≤ testStart ${f.testStart}`);
    assert.ok(f.testStart < f.testEnd, `fold ${f.fold}: empty test window`);
  }
});

test("walkForward: each fold's test window starts AFTER the previous fold's train end advances", () => {
  const bars = makeBars(800);
  const r = runWalkForwardOnSeries({ symbol: "TEST", interval: "1h", bars, cfg: baseCfg({ folds: 4 }) });
  for (let i = 1; i < r.folds.length; i++) {
    const prev = r.folds[i - 1]!;
    const cur = r.folds[i]!;
    // Train end advances forward each fold (walk-forward shifts the cut).
    assert.ok(cur.trainEnd > prev.trainEnd,
      `fold ${cur.fold}: trainEnd ${cur.trainEnd} must advance past fold ${prev.fold}'s ${prev.trainEnd}`);
    assert.ok(cur.testStart >= prev.testEnd,
      `fold ${cur.fold}: testStart ${cur.testStart} must not back-overlap fold ${prev.fold}'s testEnd ${prev.testEnd}`);
  }
});

test("walkForward: trade entries lie inside their fold's test window", () => {
  const bars = makeBars(800);
  const r = runWalkForwardOnSeries({ symbol: "TEST", interval: "1h", bars, cfg: baseCfg({ folds: 4 }) });
  for (const t of r.trades) {
    const f = r.folds.find((x) => x.fold === t.fold)!;
    assert.ok(f, `no fold metadata for trade.fold=${t.fold}`);
    assert.ok(t.entryBarTime >= f.testStart && t.entryBarTime <= f.testEnd,
      `trade entry ${t.entryBarTime} outside fold[${t.fold}] window [${f.testStart},${f.testEnd}]`);
    // detectionBarTime must be strictly BEFORE the test window starts.
    assert.ok(t.detectionBarTime <= f.testStart,
      `detectionBarTime ${t.detectionBarTime} > testStart ${f.testStart}`);
  }
});

test("walkForward: empty / too-short series returns empty result without throwing", () => {
  const r = runWalkForwardOnSeries({ symbol: "TEST", interval: "1h", bars: [], cfg: baseCfg() });
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.folds, []);
});
