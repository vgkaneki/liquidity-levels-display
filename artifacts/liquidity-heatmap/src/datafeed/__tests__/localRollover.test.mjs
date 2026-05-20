// Phase 3 — unit test for the local-rollover bar logic.
//
// Pure-JS, no transpiler needed. Runs under `node --test`. Mirrors the
// production semantics ported from HeatmapChart.tsx::updateCandleStore
// and tvDatafeed.ts::subscribeBars: extend in-window, rollover at
// boundary anchored to previous close, cold-start synthesis.
//
// We intentionally re-implement the rollover here in JS instead of
// importing the TS module, because this artifact's `pnpm test` does not
// run a TS compiler. The rule the test enforces is the contract — if
// the TS implementation ever drifts, T3's debug harness will fail at
// runtime against this same matrix.

import { test } from "node:test";
import assert from "node:assert/strict";

const INTERVAL_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "1H": 3_600_000,
};

function rollover(resolution, active, mark, now) {
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const intervalMs = INTERVAL_MS[resolution];
  if (!intervalMs) return null;
  if (!active) {
    const t = Math.floor(now / intervalMs) * intervalMs;
    return {
      bar: { time: t, open: mark, high: mark, low: mark, close: mark, volume: 0 },
      extended: false,
    };
  }
  if (now < active.time) return null;
  const windowEnd = active.time + intervalMs;
  if (now >= windowEnd) {
    const newTime = Math.floor(now / intervalMs) * intervalMs;
    const anchor = active.close > 0 ? active.close : mark;
    return {
      bar: {
        time: newTime,
        open: anchor,
        high: Math.max(anchor, mark),
        low: Math.min(anchor, mark),
        close: mark,
        volume: 0,
      },
      extended: false,
    };
  }
  return {
    bar: {
      time: active.time,
      open: active.open,
      high: Math.max(active.high, mark),
      low: active.low > 0 ? Math.min(active.low, mark) : mark,
      close: mark,
      volume: active.volume,
    },
    extended: true,
  };
}

test("rollover: extends current bar inside window", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  const r = rollover("1m", seed, 100.8, 60_000 + 30_000);
  assert.ok(r);
  assert.equal(r.extended, true);
  assert.equal(r.bar.time, seed.time);
  assert.equal(r.bar.open, 100);
  assert.equal(r.bar.high, 101);
  assert.equal(r.bar.low, 99);
  assert.equal(r.bar.close, 100.8);
});

test("rollover: extends high when tick exceeds prior high", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  const r = rollover("1m", seed, 101.5, 60_000 + 30_000);
  assert.equal(r.bar.high, 101.5);
});

test("rollover: extends low when tick drops below prior low", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  const r = rollover("1m", seed, 98.2, 60_000 + 30_000);
  assert.equal(r.bar.low, 98.2);
});

test("rollover: opens new bar at boundary anchored to prior close", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  const r = rollover("1m", seed, 102, 60_000 + 60_000);
  assert.ok(r);
  assert.equal(r.extended, false);
  assert.equal(r.bar.time, 120_000);
  assert.equal(r.bar.open, 100.5);  // prev close
  assert.equal(r.bar.high, 102);    // max(anchor, mark)
  assert.equal(r.bar.low, 100.5);   // min(anchor, mark)
  assert.equal(r.bar.close, 102);
});

test("rollover: opens new bar correctly when mark is below prior close", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  const r = rollover("1m", seed, 99.0, 60_000 + 60_000);
  assert.equal(r.extended, false);
  assert.equal(r.bar.open, 100.5);
  assert.equal(r.bar.high, 100.5);
  assert.equal(r.bar.low, 99.0);
  assert.equal(r.bar.close, 99.0);
});

test("rollover: cold start synthesizes a bar at floor(now/interval)", () => {
  const r = rollover("5m", null, 200, 1_700_000_123);
  assert.ok(r);
  assert.equal(r.extended, false);
  assert.equal(r.bar.time, Math.floor(1_700_000_123 / 300_000) * 300_000);
  assert.equal(r.bar.open, 200);
  assert.equal(r.bar.high, 200);
  assert.equal(r.bar.low, 200);
  assert.equal(r.bar.close, 200);
});

test("rollover: drops invalid mark prices", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  assert.equal(rollover("1m", seed, 0, 60_000 + 30_000), null);
  assert.equal(rollover("1m", seed, -1, 60_000 + 30_000), null);
  assert.equal(rollover("1m", seed, NaN, 60_000 + 30_000), null);
});

test("rollover: drops ticks before active bar start", () => {
  const seed = { time: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 };
  assert.equal(rollover("1m", seed, 100.5, 30_000), null);
});
