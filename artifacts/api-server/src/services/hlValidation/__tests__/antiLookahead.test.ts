// Anti-lookahead determinism + boundary semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAntiLookahead } from "../antiLookahead";
import { discoverLevelsAt } from "../engineAdapter";
import type { OhlcvBar } from "../../engines/levels";

function syntheticSeries(n: number, seed = 7): OhlcvBar[] {
  // Deterministic LCG so the test never flakes.
  let s = seed;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const bars: OhlcvBar[] = [];
  let price = 100;
  const t0 = 1700000000;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 0.5;
    const open = price;
    const close = Math.max(1, price + drift);
    const high = Math.max(open, close) + rnd() * 0.3;
    const low = Math.min(open, close) - rnd() * 0.3;
    bars.push({ time: t0 + i * 3600, open, high, low, close, volume: 100 + rnd() * 50 });
    price = close;
  }
  return bars;
}

test("anti-lookahead: discoverLevelsAt is deterministic at fixed t", () => {
  const bars = syntheticSeries(500);
  const a = discoverLevelsAt({ bars, detectionIndex: 300 });
  const b = discoverLevelsAt({ bars, detectionIndex: 300 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.price, b[i]!.price);
    assert.equal(a[i]!.density, b[i]!.density);
    assert.equal(a[i]!.tier, b[i]!.tier);
  }
});

test("anti-lookahead: passing future bars (t+50) MUST equal baseline at t", () => {
  // The chokepoint is engineAdapter's truncation. Caller hands a longer
  // slice with the SAME detectionIndex; the adapter must slice it back
  // to bars[0..t] before any computation. If we ever regress, the
  // outputs diverge and this test fails.
  const bars = syntheticSeries(600);
  const t = 350;
  const baseline = discoverLevelsAt({ bars: bars.slice(0, t), detectionIndex: t });
  const withFuture = discoverLevelsAt({ bars: bars.slice(0, t + 50), detectionIndex: t });
  assert.equal(baseline.length, withFuture.length, "level count mismatch");
  for (let i = 0; i < baseline.length; i++) {
    assert.equal(baseline[i]!.price, withFuture[i]!.price, `level[${i}].price drift`);
    assert.equal(baseline[i]!.density, withFuture[i]!.density, `level[${i}].density drift`);
    assert.equal(baseline[i]!.tier, withFuture[i]!.tier, `level[${i}].tier drift`);
    assert.equal(baseline[i]!.touches, withFuture[i]!.touches, `level[${i}].touches drift`);
  }
});

test("anti-lookahead: orchestrator-style report passes on synthetic data", () => {
  const bars = syntheticSeries(800);
  const r = runAntiLookahead([{ coin: "TEST", interval: "1h", bars }], 4);
  assert.equal(r.passed, true, `cases: ${JSON.stringify(r.cases)}`);
  assert.equal(r.cases.length, 4);
  for (const c of r.cases) assert.equal(c.ok, true, `case ${c.t} failed`);
});
