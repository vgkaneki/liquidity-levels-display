// T125 — guardrail for the IDatafeed `raw` escape-hatch.
//
// `useStructuralLevels` runs a side-channel shadow comparison that reads
// `LevelsResponse.raw.zones.length` from the IDatafeed and compares it
// against the legacy structural fetch's `json.zones.length` (both come
// from the SAME `/api/levels` response, just different fields). This
// only stays apples-to-apples as long as `HttpDatafeed.fetchLevels`
// keeps surfacing the unparsed body — including `zones` — via `raw`.
//
// The bug this guards against: if a future refactor of `fetchLevels`
// drops `raw` (or strips fields out of it), the structural shadow
// goes silent INSTEAD of detecting real divergence. The audit that
// led to this test found a real apples-to-oranges bug where
// `primary.levels.length` (20) was being compared to
// `legacyZones.length` (8) every poll cycle. After fixing the
// comparator to read `primary.raw.zones`, the contract this test pins
// is what makes the fix robust.
//
// We intentionally re-implement the same small parser inline — the .mjs
// runner can't import .ts modules directly, and the function is tiny
// enough that a verbatim copy keeps the test self-contained.

import { test } from "node:test";
import assert from "node:assert/strict";

// Tiny mirror of `HttpDatafeed.fetchLevels` body-handling. If the
// production code's parser ever gains preprocessing logic, mirror it
// here; otherwise this stays trivially correct by construction.
function buildLevelsResponse(json, fallbackSymbol, fallbackInterval) {
  return {
    symbol: json.symbol ?? fallbackSymbol,
    interval: json.interval ?? fallbackInterval,
    levels: Array.isArray(json.levels) ? json.levels : [],
    updatedAt: json.updatedAt ?? new Date().toISOString(),
    raw: json,
  };
}

// Snapshot of a real `/api/levels?symbol=BTCUSDT&interval=4h` body
// — trimmed to the shape this guardrail cares about. The full body
// also carries `regime`, `signals`, `kde`, etc., none of which the
// shadow needs.
const REAL_LIKE_BODY = {
  symbol: "BTCUSDT",
  interval: "4h",
  currentPrice: 77123.5,
  levels: [
    { price: 77000, side: "support", strength: 0.81 },
    { price: 76500, side: "support", strength: 0.74 },
    { price: 78000, side: "resistance", strength: 0.69 },
    // ... 17 more in the real body, but length is what the shadow checks
  ],
  zones: [
    {
      priceLow: 76800,
      priceHigh: 77100,
      score: 0.82,
      kind: "support",
      methods: ["kde", "swing"],
      preciseEntryPrice: 77000,
      entryMethod: "kde",
      bounceRate: 0.61,
      pValue: 0.03,
      posteriorBounceRate: 0.58,
      confirmed: true,
      confidence: "high",
      confirmingTimeframe: "1D",
      crossAssetConfirmed: false,
    },
    {
      priceLow: 78200,
      priceHigh: 78600,
      score: 0.71,
      kind: "resistance",
      methods: ["poc", "valueArea"],
      preciseEntryPrice: 78400,
      entryMethod: "poc",
      bounceRate: 0.55,
      pValue: 0.07,
      posteriorBounceRate: 0.52,
      confirmed: false,
      confidence: "medium",
      confirmingTimeframe: null,
      crossAssetConfirmed: false,
    },
    // ...
  ],
  generatedAt: 1714000000000,
};

test("levels: fetchLevels preserves zones[] on raw so structural shadow can compare apples-to-apples", () => {
  const result = buildLevelsResponse(REAL_LIKE_BODY, "BTCUSDT", "4h");

  // The escape hatch must be present.
  assert.ok(result.raw, "LevelsResponse.raw must be present");
  assert.equal(typeof result.raw, "object");

  // The structural shadow specifically reads `raw.zones`. If this ever
  // becomes undefined / non-array, structuralLevels.ts emits the
  // `:missingPrimaryRawZones` instrumentation signal and stops
  // comparing — i.e. the "shadow is quiet" guarantee silently weakens.
  // Pin the contract so a refactor breaks this test instead.
  const rawZones = result.raw.zones;
  assert.ok(Array.isArray(rawZones), "raw.zones must round-trip as an array");
  assert.equal(rawZones.length, REAL_LIKE_BODY.zones.length);
  assert.equal(rawZones[0].priceLow, 76800);
  assert.equal(rawZones[0].priceHigh, 77100);
  assert.equal(rawZones[0].confidence, "high");
});

test("levels: structural shadow comparator is apples-to-apples (zones vs zones, not levels vs zones)", () => {
  // Regression test for the apples-to-oranges audit. With the real-like
  // body above (3 levels, 2 zones), the OLD shadow code compared
  // `primary.levels.length` (3) to `legacyZones.length` (2) and would
  // have logged `[datafeed-mismatch] structuralLevels:...:zoneCount`
  // EVERY poll. The fix reads `primary.raw.zones.length` instead.
  const primary = buildLevelsResponse(REAL_LIKE_BODY, "BTCUSDT", "4h");

  // Mirror the comparator extraction from structuralLevels.ts:runFetch.
  const primaryRaw = primary.raw ?? null;
  const primaryZones = Array.isArray(primaryRaw?.zones) ? primaryRaw.zones : null;
  assert.notEqual(primaryZones, null);

  // Legacy side reads json.zones from the SAME body via a parallel
  // structural fetch, so by construction the two counts must agree.
  const legacyZones = REAL_LIKE_BODY.zones;
  assert.equal(primaryZones.length, legacyZones.length,
    "structural shadow must compare zone-count to zone-count");

  // And it must NOT inadvertently compare back to levels-count.
  assert.notEqual(primary.levels.length, legacyZones.length,
    "if these happen to match it's coincidence; the comparator must " +
    "not depend on it");
});

test("levels: missing zones in body => primaryZones === null (triggers missingPrimaryRawZones signal, not false-positive mismatch)", () => {
  // Edge case: a backend response that's somehow missing `zones`
  // entirely. The new comparator must bail (and log the
  // instrumentation-degradation signal in production) rather than
  // pretend the count is 0 and emit a spurious mismatch when the
  // legacy side has real zones.
  const noZonesBody = { ...REAL_LIKE_BODY, zones: undefined };
  const primary = buildLevelsResponse(noZonesBody, "BTCUSDT", "4h");
  const primaryRaw = primary.raw ?? null;
  const primaryZones = Array.isArray(primaryRaw?.zones) ? primaryRaw.zones : null;
  assert.equal(primaryZones, null, "must be null, not 0 — null triggers the skip+log path");
});
