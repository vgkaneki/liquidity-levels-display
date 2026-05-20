import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  logReturns,
  hurstExponent,
  regimeFromHurst,
  garchVolatility,
  garchRegime,
  rollingGarchHistory,
} from "./regime";

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (eps ${eps})`);

describe("regime: logReturns", () => {
  it("computes ln(b/a) for each consecutive valid pair", () => {
    const r = logReturns([100, 110, 121]);
    assert.equal(r.length, 2);
    approx(r[0]!, Math.log(1.1), 1e-12);
    approx(r[1]!, Math.log(1.1), 1e-12);
  });
  it("skips non-positive prices", () => {
    const r = logReturns([100, 0, 110, -1, 121]);
    assert.equal(r.length, 0);
  });
  it("returns empty for series shorter than 2", () => {
    assert.deepEqual(logReturns([]), []);
    assert.deepEqual(logReturns([100]), []);
  });
});

describe("regime: hurstExponent", () => {
  it("defaults to 0.5 when series is too short", () => {
    assert.equal(hurstExponent([]), 0.5);
    assert.equal(hurstExponent(new Array(63).fill(0.01)), 0.5);
  });
  it("returns a value in [0,1] for a degenerate constant series", () => {
    // A perfectly constant return series produces a cumulative ramp whose
    // R/S grows linearly with window length, so the regression slope (and
    // therefore the Hurst estimate) tends to 1. We just check bounds.
    const h = hurstExponent(new Array(128).fill(0.01));
    assert.ok(h >= 0 && h <= 1, `hurst out of range: ${h}`);
  });
  it("returns a value in [0,1] for a deterministic alternating series", () => {
    const series: number[] = [];
    for (let i = 0; i < 256; i++) series.push(i % 2 === 0 ? 0.01 : -0.01);
    const h = hurstExponent(series);
    assert.ok(h >= 0 && h <= 1, `hurst out of range: ${h}`);
    assert.ok(h < 0.5, `alternating series should be mean-reverting (h<0.5), got ${h}`);
  });
});

describe("regime: regimeFromHurst", () => {
  it("classifies mean-reverting / random / trending by threshold", () => {
    assert.deepEqual(regimeFromHurst(0.3), { label: "mean-reverting", multiplier: 1.4 });
    assert.deepEqual(regimeFromHurst(0.5), { label: "random", multiplier: 1.0 });
    assert.deepEqual(regimeFromHurst(0.8), { label: "trending", multiplier: 0.7 });
  });
});

describe("regime: garchVolatility", () => {
  it("returns 0 for series shorter than 30", () => {
    assert.equal(garchVolatility(new Array(29).fill(0.01)), 0);
  });
  it("returns a small positive number for a constant-return series", () => {
    const v = garchVolatility(new Array(60).fill(0.01));
    assert.ok(v > 0 && v < 0.01, `expected small positive vol, got ${v}`);
  });
  it("yields higher vol for a more volatile series", () => {
    const calm = new Array(100).fill(0).map((_, i) => (i % 2 ? 0.001 : -0.001));
    const wild = new Array(100).fill(0).map((_, i) => (i % 2 ? 0.05 : -0.05));
    assert.ok(garchVolatility(wild) > garchVolatility(calm));
  });
});

describe("regime: garchRegime", () => {
  it("returns 'normal' when history is too short", () => {
    assert.equal(garchRegime(0.5, [0.1, 0.2]), "normal");
  });
  it("classifies low/normal/high based on history percentiles", () => {
    const history: number[] = [];
    for (let i = 1; i <= 100; i++) history.push(i / 100);
    assert.equal(garchRegime(0.1, history), "low");
    assert.equal(garchRegime(0.5, history), "normal");
    assert.equal(garchRegime(0.95, history), "high");
  });
});

describe("regime: rollingGarchHistory", () => {
  it("produces (length - window + 1) entries", () => {
    const returns = new Array(80).fill(0.01);
    const out = rollingGarchHistory(returns, 50);
    assert.equal(out.length, 80 - 50 + 1);
    for (const v of out) assert.ok(v >= 0);
  });
});
