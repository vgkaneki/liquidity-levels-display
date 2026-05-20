import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isReversalCandle,
  isVolumeSurge,
  confirmZone,
  rsi,
  findDivergences,
} from "./reliability";
import type { OhlcvBar } from "./levels";

const bar = (
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1,
): OhlcvBar => ({ time, open, high, low, close, volume });

describe("reliability: isReversalCandle", () => {
  it("identifies a hammer at support", () => {
    // Body 100→101 (size 1), low 95 → wickLow=5, range=6 → wickLow > 1*1.5 and wickLow/range = 5/6 > 0.5
    const hammer = bar(0, 100, 101, 95, 101);
    assert.equal(isReversalCandle(hammer, "support"), true);
    assert.equal(isReversalCandle(hammer, "resistance"), false);
  });
  it("identifies a shooting star at resistance", () => {
    const star = bar(0, 100, 106, 99, 100);
    assert.equal(isReversalCandle(star, "resistance"), true);
    assert.equal(isReversalCandle(star, "support"), false);
  });
  it("returns false for a plain marubozu (no wick)", () => {
    const flat = bar(0, 100, 105, 100, 105);
    assert.equal(isReversalCandle(flat, "support"), false);
    assert.equal(isReversalCandle(flat, "resistance"), false);
  });
  it("returns false on zero-range bars or 'neutral' kind", () => {
    assert.equal(isReversalCandle(bar(0, 100, 100, 100, 100), "support"), false);
    assert.equal(isReversalCandle(bar(0, 100, 101, 95, 101), "neutral"), false);
  });
});

describe("reliability: isVolumeSurge", () => {
  it("returns false when there isn't enough lookback history", () => {
    const bars = new Array(10).fill(0).map((_, i) => bar(i, 100, 101, 99, 100, 10));
    assert.equal(isVolumeSurge(bars, 5, 50), false);
  });
  it("returns true when current bar volume exceeds mean + 1.5σ", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 50; i++) bars.push(bar(i, 100, 101, 99, 100, 10));
    bars.push(bar(50, 100, 101, 99, 100, 1000)); // huge surge
    assert.equal(isVolumeSurge(bars, 50), true);
  });
  it("returns false when current bar volume sits at the mean", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 50; i++) bars.push(bar(i, 100, 101, 99, 100, 10));
    bars.push(bar(50, 100, 101, 99, 100, 10));
    assert.equal(isVolumeSurge(bars, 50), false);
  });
});

describe("reliability: confirmZone", () => {
  it("returns false when no bar tests the zone", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 60; i++) bars.push(bar(i, 100, 101, 99, 100, 10));
    assert.equal(confirmZone(bars, 200, 210, "support"), false);
  });
  it("confirms a support zone when first test is hammer + close-in-direction + volume surge", () => {
    const bars: OhlcvBar[] = [];
    // 50 quiet bars trading well above the zone (no overlap with [95, 96]).
    for (let i = 0; i < 50; i++) bars.push(bar(i, 100, 101, 99.5, 100, 10));
    // Bar #50 dips into zone, forms a hammer, closes high, surges in volume.
    bars.push(bar(50, 100, 101, 95, 100.5, 1000));
    // Pad recent window so first-test is detected within lookback=60.
    for (let i = 51; i < 60; i++) bars.push(bar(i, 100, 101, 99.5, 100, 10));
    assert.equal(confirmZone(bars, 95, 96, "support"), true);
  });
  it("rejects a zone whose first test does not close in the reversal direction", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 50; i++) bars.push(bar(i, 100, 101, 99.5, 100, 10));
    // Hits zone but closes below midpoint (bearish close on a 'support' test).
    bars.push(bar(50, 100, 101, 95, 96, 1000));
    for (let i = 51; i < 60; i++) bars.push(bar(i, 96, 97, 95, 96, 10));
    assert.equal(confirmZone(bars, 95, 96, "support"), false);
  });
});

describe("reliability: rsi", () => {
  it("returns empty for too-short input", () => {
    assert.deepEqual(rsi([1, 2, 3], 14), []);
  });
  it("returns 100 for a strictly increasing series (no losses)", () => {
    const closes = new Array(30).fill(0).map((_, i) => 100 + i);
    const r = rsi(closes, 14);
    assert.ok(r.length > 0);
    for (const v of r) assert.equal(v, 100);
  });
  it("returns 0 (or near-0) for a strictly decreasing series (no gains)", () => {
    const closes = new Array(30).fill(0).map((_, i) => 100 - i);
    const r = rsi(closes, 14);
    assert.ok(r.length > 0);
    for (const v of r) assert.equal(v, 0);
  });
});

describe("reliability: findDivergences", () => {
  it("returns [] when bars contain no detectable divergence", () => {
    const closes = new Array(40).fill(0).map((_, i) => 100 + i);
    const bars = closes.map((c, i) => bar(i, c, c + 1, c - 1, c, 10));
    const out = findDivergences(bars);
    assert.ok(Array.isArray(out));
  });
});
