import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HlL2Book, HlTrade } from "../hyperliquid";
import { computeVpin, computeObi, bucketTradesByCandle } from "./orderflow";

const trade = (side: "B" | "A", px: number, sz: number, time = 0): HlTrade => ({
  coin: "X",
  side,
  px: String(px),
  sz: String(sz),
  time,
  hash: "0x",
  tid: 0,
});

describe("orderflow: computeVpin", () => {
  it("returns 0 for empty trades or zero bucket size", () => {
    assert.equal(computeVpin([], 100), 0);
    assert.equal(computeVpin([trade("B", 100, 1)], 0), 0);
  });
  it("returns 1.0 when every bucket is fully one-sided", () => {
    const trades = new Array(20).fill(0).map(() => trade("B", 100, 5));
    // bucketSize=10 → each bucket holds two buys, no sells → |10-0|/10 = 1
    const v = computeVpin(trades, 10);
    assert.equal(v, 1);
  });
  it("returns 0 when each bucket is perfectly balanced", () => {
    const trades: HlTrade[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(trade("B", 100, 5));
      trades.push(trade("A", 100, 5));
    }
    const v = computeVpin(trades, 10);
    assert.equal(v, 0);
  });
});

describe("orderflow: computeObi", () => {
  const book = (bids: Array<[number, number]>, asks: Array<[number, number]>): HlL2Book => ({
    coin: "X",
    time: 0,
    levels: [
      bids.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 })),
      asks.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 })),
    ],
  });
  it("returns 0 for empty book", () => {
    assert.equal(computeObi(book([], [])), 0);
  });
  it("returns 0 when bid and ask volumes match", () => {
    assert.equal(computeObi(book([[100, 5]], [[101, 5]])), 0);
  });
  it("returns +1 when only bids exist, -1 when only asks", () => {
    assert.equal(computeObi(book([[100, 5]], [])), 1);
    assert.equal(computeObi(book([], [[101, 5]])), -1);
  });
  it("respects depth parameter", () => {
    const b = book(
      [[100, 1], [99, 100]],
      [[101, 1], [102, 100]],
    );
    // depth=1 → bid=1, ask=1 → 0
    assert.equal(computeObi(b, 1), 0);
  });
});

describe("orderflow: bucketTradesByCandle", () => {
  it("groups trades into time buckets and sums by side", () => {
    const candleMs = 1000;
    const trades = [
      trade("B", 100, 1, 100),
      trade("A", 100, 2, 500),
      trade("B", 100, 3, 1500),
    ];
    const m = bucketTradesByCandle(trades, candleMs);
    assert.equal(m.size, 2);
    assert.deepEqual(m.get(0), { buy: 1, sell: 2 });
    assert.deepEqual(m.get(1000), { buy: 3, sell: 0 });
  });
});
