// benchmarks — count-matched + reproducible across calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateBenchmarks } from "../benchmarks";
import type { OhlcvBar } from "../../engines/levels";

function makeBars(n: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 8) * 2;
    const close = 100 + drift;
    const high = Math.max(price, close) + 0.5;
    const low = Math.min(price, close) - 0.5;
    bars.push({ time: 1700000000 + i * 3600, open: price, close, high, low, volume: 100 });
    price = close;
  }
  return bars;
}

test("benchmarks: random kind count matches countToMatch", () => {
  const bars = makeBars(400);
  const b6 = generateBenchmarks(bars, 200, "1h", 6, "BTC|1h|0").filter((x) => x.kind === "random");
  const b12 = generateBenchmarks(bars, 200, "1h", 12, "BTC|1h|0").filter((x) => x.kind === "random");
  assert.equal(b6.length, 6);
  assert.equal(b12.length, 12);
});

test("benchmarks: same seed → identical random output", () => {
  const bars = makeBars(400);
  const a = generateBenchmarks(bars, 200, "1h", 8, "BTC|1h|0").filter((x) => x.kind === "random");
  const b = generateBenchmarks(bars, 200, "1h", 8, "BTC|1h|0").filter((x) => x.kind === "random");
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.price, b[i]!.price);
    assert.equal(a[i]!.side, b[i]!.side);
  }
});

test("benchmarks: different seedKey → different random samples", () => {
  const bars = makeBars(400);
  const a = generateBenchmarks(bars, 200, "1h", 8, "BTC|1h|0").filter((x) => x.kind === "random");
  const b = generateBenchmarks(bars, 200, "1h", 8, "BTC|1h|9").filter((x) => x.kind === "random");
  let differs = false;
  for (let i = 0; i < a.length; i++) if (a[i]!.price !== b[i]!.price) { differs = true; break; }
  assert.ok(differs, "seed change must perturb the random benchmarks");
});

test("benchmarks: empty when training window has < 20 bars", () => {
  const bars = makeBars(400);
  assert.deepEqual(generateBenchmarks(bars, 5, "1h", 6, "X"), []);
});
