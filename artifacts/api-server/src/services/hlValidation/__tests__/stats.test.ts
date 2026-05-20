// Wilson 95% CI sanity tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson, proportion, sampleLabel } from "../stats";

test("wilson: zero sample returns degenerate (0,0,0)", () => {
  const w = wilson(0, 0);
  assert.equal(w.p, 0);
  assert.equal(w.low95, 0);
  assert.equal(w.high95, 0);
});

test("wilson: 50/100 → centred near 0.5 with width ~0.10", () => {
  const w = wilson(50, 100);
  assert.equal(w.p, 0.5);
  assert.ok(w.low95 < 0.5 && w.low95 > 0.39, `low ${w.low95}`);
  assert.ok(w.high95 > 0.5 && w.high95 < 0.61, `high ${w.high95}`);
  assert.ok(w.high95 - w.low95 > 0.18 && w.high95 - w.low95 < 0.22);
});

test("wilson: extreme k=n stays inside [0,1]", () => {
  const w = wilson(10, 10);
  assert.ok(w.low95 >= 0 && w.high95 <= 1);
  assert.ok(w.low95 > 0.65, `low ${w.low95}`);   // small-sample shrinkage
  assert.ok(w.high95 >= 0.999 && w.high95 <= 1, `high ${w.high95}`);   // capped at 1, FP-tolerant
});

test("wilson: k=0 keeps low at 0 and gives wide upper", () => {
  const w = wilson(0, 30);
  assert.equal(w.low95, 0);
  assert.ok(w.high95 > 0.05 && w.high95 < 0.20, `high ${w.high95}`);
});

test("wilson: width shrinks monotonically with n at fixed p", () => {
  const widths = [50, 200, 800].map((n) => {
    const w = wilson(Math.round(n * 0.3), n);
    return w.high95 - w.low95;
  });
  assert.ok(widths[0]! > widths[1]!);
  assert.ok(widths[1]! > widths[2]!);
});

test("proportion + sampleLabel boundaries match spec", () => {
  assert.equal(sampleLabel(29), "very-low");
  assert.equal(sampleLabel(30), "low");
  assert.equal(sampleLabel(99), "low");
  assert.equal(sampleLabel(100), "moderate");
  assert.equal(sampleLabel(299), "moderate");
  assert.equal(sampleLabel(300), "headline");

  const p = proportion(150, 300);
  assert.equal(p.k, 150);
  assert.equal(p.n, 300);
  assert.equal(p.p, 0.5);
  assert.equal(p.label, "headline");
});
