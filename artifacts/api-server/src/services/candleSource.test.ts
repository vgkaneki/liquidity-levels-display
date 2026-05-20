// Unit tests for the unified candle source. We monkey-patch
// `globalThis.fetch` BEFORE importing the module under test (matches
// the pattern in routes/levels.soak.test.ts) so that both the
// Hyperliquid client and the Toobit REST client see the mock.
//
// Coverage:
//   1. HL success → source === "hyperliquid", Toobit is never called.
//   2. HL 429 + Toobit gate ON  → fallback fires, source === "toobit",
//      bars are reshaped into HlCandle order.
//   3. HL empty (null) + Toobit gate ON → fallback fires.
//   4. HL 429 + Toobit gate OFF → original error is preserved (no mask).
//   5. POL→MATIC base remap is applied on the Toobit URL.

import { test } from "node:test";
import assert from "node:assert/strict";

type MockResponse = { status: number; body: unknown };
type FetchSpy = {
  calls: Array<{ url: string }>;
  hyperliquidResponse: MockResponse;
  toobitResponse: MockResponse;
};

function installFetchSpy(spy: FetchSpy): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: unknown,
  ) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    spy.calls.push({ url });
    const which = url.includes("hyperliquid") ? spy.hyperliquidResponse : spy.toobitResponse;
    return new Response(JSON.stringify(which.body), {
      status: which.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeHlCandlePayload(): unknown[] {
  // Three 1h bars in HL's wire shape (strings except t/T/n).
  const t0 = 1_700_000_000_000;
  return [0, 1, 2].map((i) => ({
    t: t0 + i * 3_600_000,
    T: t0 + (i + 1) * 3_600_000 - 1,
    s: "BTC",
    i: "1h",
    o: String(50000 + i),
    c: String(50010 + i),
    h: String(50020 + i),
    l: String(49990 + i),
    v: "100",
    n: 10,
  }));
}

function makeToobitKlinePayload(): unknown[] {
  // Three 1h bars in Toobit's array shape [t,o,h,l,c,v,...].
  const t0 = 1_700_000_000_000;
  return [0, 1, 2].map((i) => [
    t0 + i * 3_600_000,
    "60000",
    "60050",
    "59990",
    "60030",
    "200",
  ]);
}

// Toobit gate must be ON for fallback paths; the gate reads env at call time.
process.env.ENABLE_TOOBIT = "1";

const spy: FetchSpy = {
  calls: [],
  hyperliquidResponse: { status: 200, body: makeHlCandlePayload() },
  toobitResponse: { status: 200, body: makeToobitKlinePayload() },
};
installFetchSpy(spy);

// Import AFTER the fetch monkey-patch so the modules close over the spy.
const mod = await import("./candleSource");

test("hyperliquid success → source=hyperliquid, no Toobit call", async () => {
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 200, body: makeHlCandlePayload() };
  mod.__resetCandleSourceCache();
  const out = await mod.fetchCandlesSourced("BTC", "1h", 3 * 3_600_000);
  assert.equal(out.source, "hyperliquid");
  assert.equal(out.candles.length, 3);
  assert.ok(spy.calls.every((c) => !c.url.includes("toobit")), "Toobit must not be called on HL success");
});

test("hyperliquid 429 + Toobit gate ON → fallback to Toobit", async () => {
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 429, body: { error: "rate limited" } };
  spy.toobitResponse = { status: 200, body: makeToobitKlinePayload() };
  mod.__resetCandleSourceCache();
  const out = await mod.fetchCandlesSourced("ETH", "1h", 3 * 3_600_000);
  assert.equal(out.source, "toobit");
  assert.equal(out.candles.length, 3);
  // Bars are reshaped into HlCandle (string OHLCV, t/T numeric).
  assert.equal(typeof out.candles[0]!.t, "number");
  assert.equal(typeof out.candles[0]!.o, "string");
  assert.equal(out.candles[0]!.s, "ETH");
  assert.ok(spy.calls.some((c) => c.url.includes("toobit")), "Toobit should have been called");
});

test("hyperliquid empty array + Toobit gate ON → fallback to Toobit", async () => {
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 200, body: [] };
  spy.toobitResponse = { status: 200, body: makeToobitKlinePayload() };
  mod.__resetCandleSourceCache();
  const out = await mod.fetchCandlesSourced("SOL", "1h", 3 * 3_600_000);
  assert.equal(out.source, "toobit");
  assert.equal(out.candles.length, 3);
});

test("hyperliquid 429 + Toobit gate OFF → original behavior (throws)", async () => {
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 429, body: { error: "rate limited" } };
  spy.toobitResponse = { status: 200, body: makeToobitKlinePayload() };
  mod.__resetCandleSourceCache();
  delete process.env.ENABLE_TOOBIT;
  await assert.rejects(() => mod.fetchCandlesSourced("AVAX", "1h", 3 * 3_600_000));
  // Toobit must not have been touched.
  assert.ok(spy.calls.every((c) => !c.url.includes("toobit")), "Toobit must not be called when gate is off");
  process.env.ENABLE_TOOBIT = "1";
});

test("monthly '1M' interval is preserved (not lowercased to '1m')", async () => {
  // Regression test: a blanket .toLowerCase() in interval mapping would
  // turn the monthly bucket "1M" into "1m" (minute) and silently return
  // per-minute bars for a monthly request — completely wrong horizon.
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 429, body: { error: "rate limited" } };
  spy.toobitResponse = { status: 200, body: makeToobitKlinePayload() };
  mod.__resetCandleSourceCache();
  await mod.fetchCandlesSourced("BTC", "1M", 12 * 30 * 86_400_000);
  const tbCall = spy.calls.find((c) => c.url.includes("toobit"));
  assert.ok(tbCall, "Toobit must be called");
  assert.match(tbCall!.url, /interval=1M/, "Toobit URL must keep monthly token as '1M'");
});

test("POL → MATIC base remap on Toobit URL", async () => {
  spy.calls.length = 0;
  spy.hyperliquidResponse = { status: 200, body: [] };
  spy.toobitResponse = { status: 200, body: makeToobitKlinePayload() };
  mod.__resetCandleSourceCache();
  const out = await mod.fetchCandlesSourced("POL", "1h", 3 * 3_600_000);
  assert.equal(out.source, "toobit");
  const tbCall = spy.calls.find((c) => c.url.includes("toobit"));
  assert.ok(tbCall, "Toobit must be called");
  assert.match(tbCall!.url, /MATIC-SWAP-USDT/, "Toobit URL must use MATIC base after remap");
});
