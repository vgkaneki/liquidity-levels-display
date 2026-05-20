import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findPivots,
  kde,
  buildPriceGrid,
  kdePeaks,
  marketProfile,
  validateLevel,
  type OhlcvBar,
} from "./levels";

const bar = (
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1,
): OhlcvBar => ({ time, open, high, low, close, volume });

describe("levels: findPivots", () => {
  it("identifies a single swing high and low surrounded by k bars", () => {
    // 5 bars, k=2: only middle bar can be a pivot.
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 102, 98, 100),
      bar(2, 100, 105, 95, 100), // swing high & swing low
      bar(3, 100, 102, 98, 100),
      bar(4, 100, 101, 99, 100),
    ];
    const { highs, lows } = findPivots(bars, 2);
    assert.equal(highs.length, 1);
    assert.equal(lows.length, 1);
    assert.equal(highs[0]!.time, 2);
    assert.equal(lows[0]!.time, 2);
  });
});

describe("levels: kde / buildPriceGrid / kdePeaks", () => {
  it("buildPriceGrid produces bins+1 evenly spaced points", () => {
    const grid = buildPriceGrid(0, 10, 10);
    assert.equal(grid.length, 11);
    assert.equal(grid[0], 0);
    assert.equal(grid[10], 10);
  });
  it("kde density peaks near the cluster mean", () => {
    // Two tight clusters at 100 and 200.
    const prices = [
      99, 100, 101, 100, 100,
      199, 200, 201, 200, 200,
    ];
    const grid = buildPriceGrid(50, 250, 200);
    const density = kde(prices, grid);
    assert.equal(density.length, grid.length);
    for (const d of density) assert.ok(d >= 0);
    const peaks = kdePeaks(grid, density, 5);
    assert.ok(peaks.length >= 2, `expected ≥ 2 peaks, got ${peaks.length}`);
    // The top two peaks should sit close to 100 and 200.
    const topPrices = peaks.slice(0, 2).map((p) => p.price).sort((a, b) => a - b);
    assert.ok(Math.abs(topPrices[0]! - 100) < 5, `bottom peak ${topPrices[0]} not near 100`);
    assert.ok(Math.abs(topPrices[1]! - 200) < 5, `top peak ${topPrices[1]} not near 200`);
  });
  it("kde returns zeros for empty input", () => {
    const grid = [1, 2, 3];
    assert.deepEqual(kde([], grid), [0, 0, 0]);
  });
});

describe("levels: marketProfile", () => {
  it("returns empties for no bars", () => {
    const p = marketProfile([]);
    assert.deepEqual(p, { bins: [], poc: 0, valueAreaHigh: 0, valueAreaLow: 0 });
  });
  it("places POC near the price band that the most bars span", () => {
    // 9 bars all touching 100, only 1 bar at 200 → POC should be near 100.
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 9; i++) bars.push(bar(i, 100, 101, 99, 100));
    bars.push(bar(9, 200, 201, 199, 200));
    const p = marketProfile(bars, 80);
    assert.ok(Math.abs(p.poc - 100) < 5, `expected POC near 100, got ${p.poc}`);
    assert.ok(p.valueAreaLow <= p.poc && p.poc <= p.valueAreaHigh);
  });
});

describe("levels: validateLevel", () => {
  it("returns zero touches when nothing tests the level", () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100)];
    const v = validateLevel(bars, 200, 0.5);
    assert.equal(v.touches, 0);
    assert.equal(v.bounceRate, 0);
    assert.equal(v.pValue, 1);
  });
  it("counts touches and bounces; bounceRate is 1 when every touch bounces", () => {
    // Build bars where every touch is followed by a clear move > 2*tolerance.
    const tol = 0.5;
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 6; i++) {
      // Touch bar at price 100
      bars.push(bar(i * 10, 100, 100.4, 99.6, 100));
      // 5 follow-up bars that move clearly away
      for (let j = 1; j <= 5; j++) bars.push(bar(i * 10 + j, 105, 106, 104, 105));
    }
    // Add tail so last touch has lookahead room
    for (let j = 0; j < 6; j++) bars.push(bar(1000 + j, 105, 106, 104, 105));
    const v = validateLevel(bars, 100, tol, 5);
    assert.ok(v.touches >= 6, `expected ≥6 touches, got ${v.touches}`);
    assert.equal(v.bounceRate, 1);
    assert.ok(v.pValue >= 0 && v.pValue <= 1);
    assert.ok(v.pValue < 0.5, `expected significant pValue, got ${v.pValue}`);
  });
});
