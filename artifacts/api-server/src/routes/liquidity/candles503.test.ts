// Regression test for Task #103: /api/liquidity/candles MUST return 503
// when every upstream candle source (Hyperliquid, Toobit, OKX) fails.
// Previously this route fell back to a synthetic generator built from a
// hard-coded base price, masking exchange outages with fake bars. This
// test asserts the honest 503-on-total-outage contract.
//
// We monkey-patch `globalThis.fetch` BEFORE importing the route so all
// three exchange adapters see a mocked transport that returns 503 for
// every upstream call. The Toobit gate is enabled so the route exercises
// the full HL → Toobit → OKX fallback ladder, not just two of three.

import { test } from "node:test";
import assert from "node:assert/strict";

// Tell the route module not to start its WS / sampler boot side effects
// when we import it for testing — see the matching guard in
// `routes/liquidity/index.ts`. Without this, the imported module would
// open long-lived sockets that hold the event loop open after assertions.
process.env["SKIP_LIVE_BOOT"] = "1";
process.env["ENABLE_TOOBIT"] = "1";
process.env["TOOBIT_GEO_HEADER"] = "test";

// Install the `require` shim before the route module loads. Production
// bundles get this from an esbuild banner; under tsx (ESM) we install
// it ourselves so the route's `require("./exchanges/toobit-ws")` call
// resolves cleanly when Toobit is enabled.
const { createRequire: __cr } = await import("node:module");
(globalThis as { require?: NodeRequire }).require = __cr(import.meta.url);

// Mock global fetch. Pass-through localhost so the test client can talk
// to the in-process express server; everything else gets a 503 upstream
// response (or a benign empty list for OKX instruments so the route
// module finishes loading without errors).
const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  input: unknown,
  init?: RequestInit,
) => {
  const url = typeof input === "string" ? input : (input as { url: string }).url;
  if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }
  if (url.includes("/api/v5/public/instruments")) {
    return new Response(JSON.stringify({ code: "0", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "upstream down" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

const express = (await import("express")).default;
const { default: router } = await import("./index");

test("GET /liquidity/candles returns 503 when HL + Toobit + OKX all fail", async () => {
  const app = express();
  app.use("/api", router);

  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/liquidity/candles?symbol=NOPEUSDT&interval=4H&limit=50`,
    );
    assert.equal(res.status, 503, "expected 503 when all upstream candle sources fail");
    const body = (await res.json()) as { error: string; symbol: string };
    assert.match(body.error, /no live candles/);
    assert.equal(body.symbol, "NOPEUSDT");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
