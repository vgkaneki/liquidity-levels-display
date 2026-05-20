// evaluator — TP / SL / timeout outcome correctness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTrade } from "../evaluator";
import type { OhlcvBar } from "../../engines/levels";

function flatBars(n: number, price: number, atr = 1): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      time: 1700000000 + i * 3600,
      open: price, close: price,
      high: price + atr / 2, low: price - atr / 2,
      volume: 100,
    });
  }
  return bars;
}

test("evaluator: long takes profit at +tpR*stop", () => {
  const det = flatBars(60, 100, 1);
  const fwd: OhlcvBar[] = [
    // bar 0: touches level 100, no TP/SL
    { time: 1, open: 100.5, high: 100.6, low: 99.95, close: 100.4, volume: 1 },
    // bar 1: spike up — should hit TP first
    { time: 2, open: 100.4, high: 105, low: 100.4, close: 104.9, volume: 1 },
  ];
  const t = evaluateTrade({
    symbol: "T", interval: "1h", side: "long", levelTier: "normal",
    level: 100, detectionBars: det, forwardBars: fwd,
    tpR: 1.5, slAtrMult: 1.0, timeoutBars: 12, feeBps: 0, slippageBps: 0,
    fold: 0, detectionBarTime: 0,
  });
  assert.ok(t, "trade should be returned");
  assert.equal(t!.outcome, "win");
  assert.ok(t!.rMultiple > 1.4 && t!.rMultiple <= 1.5, `R=${t!.rMultiple}`);
});

test("evaluator: long stops out at -1R", () => {
  const det = flatBars(60, 100, 1);
  const fwd: OhlcvBar[] = [
    // Touch the level (low ≤ 100, high small enough to NOT hit TP=+1.5R first)
    { time: 1, open: 100.05, high: 100.15, low: 99.95, close: 100.0, volume: 1 },
    // Then plunge — SL must be the first thing hit
    { time: 2, open: 100.0, high: 100.05, low: 95, close: 95.5, volume: 1 },
  ];
  const t = evaluateTrade({
    symbol: "T", interval: "1h", side: "long", levelTier: "normal",
    level: 100, detectionBars: det, forwardBars: fwd,
    tpR: 1.5, slAtrMult: 1.0, timeoutBars: 12, feeBps: 0, slippageBps: 0,
    fold: 0, detectionBarTime: 0,
  });
  assert.ok(t);
  assert.equal(t!.outcome, "loss");
  assert.ok(t!.rMultiple < -0.9 && t!.rMultiple >= -1.05, `R=${t!.rMultiple}`);
});

test("evaluator: timeout when neither TP nor SL hits", () => {
  // Bigger ATR pushes TP/SL out of reach of the small drift below.
  const det = flatBars(60, 100, 4);
  const fwd: OhlcvBar[] = [{ time: 1, open: 100.0, high: 100.2, low: 99.9, close: 100.05, volume: 1 }];
  for (let i = 2; i <= 14; i++) {
    fwd.push({ time: i, open: 100.05, high: 100.1, low: 100.0, close: 100.05, volume: 1 });
  }
  const t = evaluateTrade({
    symbol: "T", interval: "1h", side: "long", levelTier: "normal",
    level: 100, detectionBars: det, forwardBars: fwd,
    tpR: 1.5, slAtrMult: 1.0, timeoutBars: 12, feeBps: 0, slippageBps: 0,
    fold: 0, detectionBarTime: 0,
  });
  assert.ok(t);
  assert.equal(t!.outcome, "timeout");
});

test("evaluator: returns null when level is never touched", () => {
  const det = flatBars(60, 100, 1);
  const fwd: OhlcvBar[] = flatBars(20, 200, 1).map((b) => ({ ...b, time: 1700100000 + b.time }));
  const t = evaluateTrade({
    symbol: "T", interval: "1h", side: "long", levelTier: "normal",
    level: 100, detectionBars: det, forwardBars: fwd,
    tpR: 1.5, slAtrMult: 1.0, timeoutBars: 12, feeBps: 0, slippageBps: 0,
    fold: 0, detectionBarTime: 0,
  });
  assert.equal(t, null);
});
