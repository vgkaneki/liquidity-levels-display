import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HlL2Book, HlTrade } from "../hyperliquid";
import {
  largestRestingOrder,
  absorptionEntry,
  deltaExhaustion,
  vwoe,
  pickPrecisionEntry,
} from "./precision";
import type { OhlcvBar } from "./levels";

const trade = (side: "B" | "A", px: number, sz: number, time = 0): HlTrade => ({
  coin: "X",
  side,
  px: String(px),
  sz: String(sz),
  time,
  hash: "0x",
  tid: 0,
});

const book = (bids: Array<[number, number]>, asks: Array<[number, number]>): HlL2Book => ({
  coin: "X",
  time: 0,
  levels: [
    bids.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 })),
    asks.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 })),
  ],
});

const bar = (
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1,
): OhlcvBar => ({ time, open, high, low, close, volume });

describe("precision: largestRestingOrder", () => {
  it("returns the price level with greatest size inside the zone", () => {
    const b = book(
      [[99, 5], [100, 50]],
      [[101, 7], [200, 9999]],
    );
    const r = largestRestingOrder(b, 99, 110);
    assert.ok(r);
    assert.equal(r!.price, 100);
    assert.equal(r!.method, "large-resting-order");
  });
  it("returns null if no levels fall inside the zone", () => {
    const b = book([[10, 1]], [[20, 1]]);
    assert.equal(largestRestingOrder(b, 1000, 2000), null);
  });
});

describe("precision: absorptionEntry", () => {
  it("returns null when no trades fall inside the zone", () => {
    assert.equal(absorptionEntry([trade("B", 1, 1)], 100, 200), null);
  });
  it("picks the bucket with the strongest one-sided pressure", () => {
    const trades = [
      // Many heavy buys at ~150 (strongly one-sided)
      ...new Array(8).fill(0).map(() => trade("B", 150, 10)),
      // Balanced flow at ~110
      trade("B", 110, 1),
      trade("A", 110, 1),
    ];
    const r = absorptionEntry(trades, 100, 200);
    assert.ok(r);
    assert.equal(r!.method, "absorption");
    assert.ok(Math.abs(r!.price - 150) < 5, `expected ~150, got ${r!.price}`);
  });
});

describe("precision: deltaExhaustion", () => {
  it("returns null if no bar overlaps the zone", () => {
    const bars = [bar(0, 100, 101, 99, 100)];
    assert.equal(deltaExhaustion(bars, 200, 300), null);
  });
  it("picks the bar with the largest wick * volume inside the zone", () => {
    const bars = [
      // Tiny wick, low volume
      bar(0, 100, 101, 99, 100, 1),
      // Big lower wick, high volume → strong exhaustion at the low
      bar(1, 100, 101, 90, 100, 1000),
    ];
    const r = deltaExhaustion(bars, 80, 110);
    assert.ok(r);
    assert.equal(r!.price, 90);
    assert.equal(r!.method, "delta-exhaustion");
  });
});

describe("precision: vwoe", () => {
  it("computes the volume-weighted average price within the zone", () => {
    const trades = [
      trade("B", 100, 1),
      trade("A", 110, 3), // VWAP = (100*1 + 110*3)/(1+3) = 107.5
      trade("B", 9999, 1000), // outside zone, ignored
    ];
    const r = vwoe(trades, 50, 200);
    assert.ok(r);
    assert.equal(r!.price, 107.5);
    assert.equal(r!.method, "vwoe");
  });
  it("returns null when zone has no trades", () => {
    assert.equal(vwoe([], 0, 100), null);
  });
});

describe("precision: pickPrecisionEntry", () => {
  it("falls back to midpoint when no candidates fire", () => {
    const r = pickPrecisionEntry([], [], book([], []), 100, 200, 150);
    assert.deepEqual(r, { price: 150, method: "midpoint" });
  });
  it("returns the highest-confidence candidate", () => {
    // Both trades land in the same absorption bucket and are perfectly
    // balanced (imbalance=0), so absorption returns null. Only vwoe fires.
    const trades = [trade("B", 105, 1000), trade("A", 105, 1000)];
    const r = pickPrecisionEntry([], trades, book([], []), 50, 200, 999);
    assert.equal(r.method, "vwoe");
    assert.equal(r.price, 105);
  });
});
