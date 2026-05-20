// engineAdapter — detectionIndex boundary truncation + live-tier mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverLevelsAt, __liveTierFromScore } from "../engineAdapter";
import type { OhlcvBar } from "../../engines/levels";

function ramp(n: number): OhlcvBar[] {
  // Two clear support/resistance bands so KDE has obvious peaks.
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / 25) % 4;
    const base = phase === 0 ? 100 : phase === 1 ? 110 : phase === 2 ? 100 : 90;
    const open = base;
    const close = base + (i % 2 === 0 ? 0.4 : -0.4);
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    bars.push({ time: 1700000000 + i * 3600, open, high, low, close, volume: 100 });
  }
  return bars;
}

test("engineAdapter: detectionIndex=0 → empty, no throw", () => {
  const bars = ramp(200);
  const r = discoverLevelsAt({ bars, detectionIndex: 0 });
  assert.deepEqual(r, []);
});

test("engineAdapter: detectionIndex > bars.length truncates safely (no future leak)", () => {
  const bars = ramp(300);
  const a = discoverLevelsAt({ bars, detectionIndex: 9999 });   // clamped to bars.length
  const b = discoverLevelsAt({ bars, detectionIndex: bars.length });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.price, b[i]!.price);
    assert.equal(a[i]!.tier, b[i]!.tier);
  }
});

test("engineAdapter: emits no level priced after the detection window", () => {
  const bars = ramp(400);
  const t = 200;
  const out = discoverLevelsAt({ bars, detectionIndex: t });
  // Every emitted level price must lie within the train-window range.
  const trainCloses = bars.slice(0, t).map((b) => b.close);
  const lo = Math.min(...trainCloses) * 0.99;
  const hi = Math.max(...trainCloses) * 1.01;
  for (const lev of out) {
    assert.ok(lev.price >= lo && lev.price <= hi,
      `level ${lev.price} outside train range [${lo}, ${hi}]`);
    assert.ok(lev.detectionBarIndex <= t,
      `detectionBarIndex ${lev.detectionBarIndex} > detectionIndex ${t}`);
  }
});

test("engineAdapter: liveTierFromScore matches sealed registry thresholds verbatim", () => {
  // These thresholds (0.4 / 0.65 / 0.85) MUST match
  // services/levelRegistry/index.ts → tierFromScore. If anyone changes
  // the registry without updating engineAdapter, this test fails and
  // the engine fingerprint hash changes.
  assert.equal(__liveTierFromScore(0.0), "filtered");
  assert.equal(__liveTierFromScore(0.39), "filtered");
  assert.equal(__liveTierFromScore(0.4), "normal");
  assert.equal(__liveTierFromScore(0.64999), "normal");
  assert.equal(__liveTierFromScore(0.65), "strong");
  assert.equal(__liveTierFromScore(0.84999), "strong");
  assert.equal(__liveTierFromScore(0.85), "elite");
  assert.equal(__liveTierFromScore(2.5), "elite");
});
