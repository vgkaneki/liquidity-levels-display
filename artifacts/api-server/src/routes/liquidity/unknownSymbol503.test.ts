// Regression test for Task #106: /api/liquidity/heatmap and
// /api/liquidity/orderbook MUST return 503 for symbols that no live
// exchange knows about. The pre-Task-#103 implementation fell back to a
// synthetic catalog (KNOWN_MARKETS + buildSyntheticOrderbook) and
// happily fabricated walls/depth for any string a caller passed in.
//
// We mock global fetch so every upstream HTTP call returns 503 (the
// websocket caches are empty in a fresh test process), which is the
// realistic "unknown symbol" condition: no OKX ticker, no HL asset,
// no Toobit support. The route handlers should respond with a 503 +
// "no live data" / "no live orderbook" payload, never a 200 with
// fabricated levels.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SKIP_LIVE_BOOT"] = "1";
// Toobit gate is intentionally OFF here — we want the route to walk the
// OKX → HL ladder and bottom out at 503 without engaging the lazy
// Toobit require, which keeps the test hermetic on machines without
// the geo-allowed Toobit egress.
delete process.env["ENABLE_TOOBIT"];

const { createRequire: __cr } = await import("node:module");
(globalThis as { require?: NodeRequire }).require = __cr(import.meta.url);

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

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api", router);
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /liquidity/heatmap returns 503 for an unknown symbol (no synthetic depth)", async () => {
  await withServer(async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/liquidity/heatmap?symbol=NOPEUSDT&levels=20`,
    );
    assert.equal(
      res.status,
      503,
      "heatmap must NOT fabricate levels for unknown symbols — it must return 503",
    );
    const body = (await res.json()) as {
      error: string;
      symbol: string;
      hasTicker: boolean;
      hasBook: boolean;
      levels?: unknown;
    };
    assert.match(body.error, /no live data/);
    assert.equal(body.symbol, "NOPEUSDT");
    assert.equal(body.hasTicker, false);
    assert.equal(body.hasBook, false);
    assert.equal(body.levels, undefined, "503 response must not carry a levels[] payload");
  });
});

test("GET /liquidity/orderbook returns 503 for an unknown symbol (no synthetic book)", async () => {
  await withServer(async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/liquidity/orderbook?symbol=NOPEUSDT&depth=10`,
    );
    assert.equal(
      res.status,
      503,
      "orderbook must NOT fabricate bids/asks for unknown symbols — it must return 503",
    );
    const body = (await res.json()) as {
      error: string;
      symbol: string;
      bids?: unknown;
      asks?: unknown;
    };
    assert.match(body.error, /no live orderbook/);
    assert.equal(body.symbol, "NOPEUSDT");
    assert.equal(body.bids, undefined, "503 response must not carry a bids[] payload");
    assert.equal(body.asks, undefined, "503 response must not carry an asks[] payload");
  });
});
