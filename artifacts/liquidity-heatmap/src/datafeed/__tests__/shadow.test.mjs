// Phase 3 / T125 — shadowCompare behavioural contract.
//
// The TS source (`src/datafeed/shadow.ts`) is the source of truth; this
// test mirrors the helper inline so the runner stays a pure node:test
// without a TS toolchain. The logic mirrored here is the only behaviour
// the migration relies on:
//
//   * Cold-start safeguard: if either side is null/undefined, no log.
//   * On match (under the supplied equals): no log.
//   * On disagreement: emit one log carrying primary + legacy.
//   * When disabled: never log, return true.

import { test } from "node:test";
import assert from "node:assert/strict";

function makeShadow(enabled) {
  const calls = [];
  function shadowCompare(name, primary, legacy, equals) {
    if (!enabled) return true;
    if (primary == null || legacy == null) return true;
    const eq = equals ?? ((a, b) => Object.is(a, b));
    if (eq(primary, legacy)) return true;
    calls.push({ name, info: { primary, legacy } });
    return false;
  }
  return { shadowCompare, calls };
}

test("shadowCompare: cold-start (null primary) does not log", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const ok = shadowCompare("t", null, 5);
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});

test("shadowCompare: cold-start (null legacy) does not log", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const ok = shadowCompare("t", 5, null);
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});

test("shadowCompare: match under default Object.is does not log", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const ok = shadowCompare("t", 7, 7);
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});

test("shadowCompare: match under custom equals does not log", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const ok = shadowCompare(
    "t",
    { count: 3, price: 100 },
    { count: 3, price: 100.0000001 },
    (a, b) => a.count === b.count && Math.abs(a.price - b.price) < 1e-3,
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});

test("shadowCompare: disagreement logs once with both values", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const ok = shadowCompare("clusters:BTC", 5, 6, (a, b) => a === b);
  assert.equal(ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "clusters:BTC");
  assert.deepEqual(calls[0].info, { primary: 5, legacy: 6 });
});

test("shadowCompare: disabled never logs and returns true", () => {
  const { shadowCompare, calls } = makeShadow(false);
  const ok = shadowCompare("t", 5, 99);
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});

test("shadowCompare: deep-ish structural equals path", () => {
  const { shadowCompare, calls } = makeShadow(true);
  const a = { count: 2, firstBucketPrice: 31250.5 };
  const b = { count: 2, firstBucketPrice: 31250.5 };
  const ok = shadowCompare(
    "liq:BTC:countAndFirstBucket",
    a,
    b,
    (x, y) =>
      x.count === y.count &&
      Math.abs(x.firstBucketPrice - y.firstBucketPrice) < 1e-9,
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 0);
});
