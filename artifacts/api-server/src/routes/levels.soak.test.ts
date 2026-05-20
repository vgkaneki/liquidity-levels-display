// Soak test for /api/levels.
//
// What this guards against
// ------------------------
// We previously shipped a regression where the boot-time warmer fan-out
// burned through Hyperliquid's per-IP rate budget and produced a 502
// storm on /api/levels for ~half the supported symbols for several
// minutes after restart (see commits leading into Task #83). The fix
// staggered the warm schedule, capped concurrent HL fetches, added a
// token bucket, and made the route do a single-attempt transient retry.
//
// This test exercises the same paths under load with a mocked upstream
// so a future regression of the rate-limiter / staggering / dedupe
// surface fails CI instead of production.
//
// Strategy
// --------
//   1. Stub `globalThis.fetch` BEFORE importing the app so every HL POST
//      is deterministic and instant. A small set of symbols are flagged
//      as upstream-unsupported (mock returns a non-retryable 422) — the
//      route should surface those as 502 and nothing else should.
//   2. Import the express app (no DB / WS hub bootstrap — those live in
//      `index.ts`, which we do NOT execute here).
//   3. Sweep the universe (~30 symbols × {1H,4H,1D}) twice:
//        - "cold" sweep with bounded concurrency simulating the boot
//          fan-out plus a few foreground requests landing on top.
//        - "warm" sweep after the periodic warmer has had time to tick,
//          confirming the cache + warmer keep the universe healthy
//          under the same load.
//   4. Assert: only the expected upstream-unsupported coins return 502,
//      every other request returns 200, and p95 wall-clock latency stays
//      under a 3 s budget.

process.env.HL_RATE_LIMIT_PER_SEC ||= "10000";
process.env.HL_RATE_LIMIT_BURST ||= "10000";
process.env.LOG_LEVEL ||= "silent";
// The full app boots optional Toobit routes that use a CommonJS-only
// `require(...)` lazy-load (see routes/liquidity/index.ts). The soak test
// only needs the levels surface, so we mount a minimal app below and
// keep this guard so an inadvertent transitive import would still see
// the flag off.
process.env.ENABLE_TOOBIT = "0";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ---- Universe under test --------------------------------------------------

const SYMBOLS: string[] = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "SUIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
  "INJUSDT", "TIAUSDT", "WIFUSDT", "PEPEUSDT", "TONUSDT",
  "TRXUSDT", "TAOUSDT", "TRUMPUSDT", "POLUSDT", "PENDLEUSDT",
  "ATOMUSDT", "FILUSDT", "RNDRUSDT", "HBARUSDT", "FETUSDT",
];
const INTERVALS = ["1H", "4H", "1D"];

// Coins (HL-side bare names) that the mock should treat as upstream-
// unsupported. The route normalises BTCUSDT -> "BTC" before talking to
// HL, so the mock matches on the bare name. The corresponding perp
// symbols are listed here so the assertion side has the same source of
// truth.
const UNSUPPORTED_COINS = new Set(["TRUMP", "POL"]);
const UNSUPPORTED_SYMBOLS = new Set(
  [...UNSUPPORTED_COINS].map((c) => `${c}USDT`),
);

// ---- Deterministic Hyperliquid mock --------------------------------------

function seedFor(coin: string): number {
  let s = 0;
  for (let i = 0; i < coin.length; i++) s = (s * 31 + coin.charCodeAt(i)) >>> 0;
  return s || 1;
}

function makeCandles(coin: string, interval: string, lookbackMs: number) {
  // Engine wants ≥30 bars; 240 keeps the KDE/market-profile/regime
  // engines happy without making compute the bottleneck of the test.
  const COUNT = 240;
  const seed = seedFor(coin);
  const step = Math.max(60_000, Math.floor(lookbackMs / COUNT));
  const now = Date.now();
  let p = 50 + (seed % 950);
  const out: Array<{
    t: number; T: number; s: string; i: string;
    o: string; c: string; h: string; l: string; v: string; n: number;
  }> = [];
  for (let i = 0; i < COUNT; i++) {
    const o = p;
    const drift = Math.sin((i + (seed % 17)) / 6) * (p * 0.008);
    const wiggle = (((seed >>> (i % 24)) & 0xff) / 255 - 0.5) * (p * 0.004);
    const c = Math.max(0.01, p + drift + wiggle);
    const h = Math.max(o, c) * 1.0015;
    const l = Math.min(o, c) * 0.9985;
    p = c;
    const t = now - (COUNT - i) * step;
    out.push({
      t, T: t + step - 1, s: coin, i: interval,
      o: o.toString(), c: c.toString(), h: h.toString(), l: l.toString(),
      v: "100", n: 5,
    });
  }
  return out;
}

function makeBook(coin: string) {
  const seed = seedFor(coin);
  const px = 50 + (seed % 950);
  const bids: Array<{ px: string; sz: string; n: number }> = [];
  const asks: Array<{ px: string; sz: string; n: number }> = [];
  for (let i = 0; i < 20; i++) {
    bids.push({ px: (px - (i + 1) * 0.05).toFixed(4), sz: "10", n: 1 });
    asks.push({ px: (px + (i + 1) * 0.05).toFixed(4), sz: "10", n: 1 });
  }
  return { coin, time: Date.now(), levels: [bids, asks] };
}

interface HlBody {
  type?: string;
  coin?: string;
  req?: { coin?: string; interval?: string; startTime?: number; endTime?: number };
}

const stats = {
  hlCalls: 0,
  unsupportedHits: 0,
  byType: new Map<string, number>(),
};

const realFetch: typeof fetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : (input as Request).url;
  if (!url.startsWith("https://api.hyperliquid.xyz")) {
    return realFetch(input as RequestInfo | URL, init);
  }
  stats.hlCalls++;
  let body: HlBody = {};
  try {
    if (typeof init?.body === "string") body = JSON.parse(init.body) as HlBody;
  } catch {
    /* ignore — empty body is fine for the default branch */
  }
  const type = body.type ?? "unknown";
  stats.byType.set(type, (stats.byType.get(type) ?? 0) + 1);
  const coin = body.req?.coin ?? body.coin ?? "";
  if (coin && UNSUPPORTED_COINS.has(coin)) {
    stats.unsupportedHits++;
    return new Response(JSON.stringify({ error: "Unsupported coin" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }
  let data: unknown;
  switch (type) {
    case "candleSnapshot": {
      const itv = body.req?.interval ?? "1h";
      const lookback = (body.req?.endTime ?? 0) - (body.req?.startTime ?? 0);
      data = makeCandles(coin, itv, Math.max(lookback, 3_600_000 * 100));
      break;
    }
    case "l2Book":
      data = makeBook(coin);
      break;
    case "recentTrades":
      data = [];
      break;
    case "metaAndAssetCtxs":
      data = [{ universe: [] }, []];
      break;
    default:
      data = {};
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// Build a minimal express app that mounts ONLY the levels router and
// the host adapter middleware that normalises symbol/interval. We
// deliberately do NOT import `../app` because the full app pulls in
// the liquidity router, which conditionally `require()`s Toobit modules
// and is incompatible with raw tsx/ESM. The route under test does not
// depend on session middleware, compression, or pino-http, so a slim
// app is the right shape for a soak test of /api/levels.
//
// Imported AFTER the fetch override so the engine's first POST already
// sees the mock. The module-level `setGlobalDispatcher` inside
// `services/hyperliquid.ts` is harmless because we replaced
// `globalThis.fetch` with a function that does not delegate to undici.
const expressMod = await import("express");
const expressFn = (expressMod as { default: typeof import("express") }).default;
const { default: levelsRouter } = await import("./levels");
const { normalizeCoin, normalizeInterval } = await import("../services/levelsHost");

const app = expressFn();
// The route uses `req.log` (pino-http). Provide a no-op logger so the
// route's structured timing/error logs don't crash the test.
app.use((req, _res, next) => {
  const noop = (..._a: unknown[]) => {};
  // @ts-expect-error injected for the soak harness
  req.log = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
  next();
});
app.use((req, _res, next) => {
  // Mirror the host adapter in routes/index.ts: rewrite the URL so the
  // levels route sees HL-shape inputs (`coin: "BTC"`, lowercase intervals).
  if (req.path !== "/api/levels") return next();
  const url = new URL(req.url, "http://internal");
  const sym = url.searchParams.get("symbol");
  const itv = url.searchParams.get("interval");
  if (sym) url.searchParams.set("symbol", normalizeCoin(sym));
  if (itv) url.searchParams.set("interval", normalizeInterval(itv));
  req.url = url.pathname + url.search;
  next();
});
app.use("/api", levelsRouter);

// ---- HTTP harness ---------------------------------------------------------

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface SweepRow { symbol: string; interval: string; status: number; ms: number }

async function callLevels(symbol: string, interval: string): Promise<SweepRow> {
  const t0 = performance.now();
  const res = await realFetch(`${baseUrl}/api/levels?symbol=${symbol}&interval=${interval}`);
  await res.arrayBuffer();
  return { symbol, interval, status: res.status, ms: performance.now() - t0 };
}

async function sweep(concurrency: number): Promise<SweepRow[]> {
  const jobs: Array<[string, string]> = [];
  for (const sym of SYMBOLS) for (const itv of INTERVALS) jobs.push([sym, itv]);
  const out: SweepRow[] = new Array(jobs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= jobs.length) return;
        const [sym, itv] = jobs[i]!;
        out[i] = await callLevels(sym, itv);
      }
    }),
  );
  return out;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(idx, 0)]!;
}

function summarize(rows: SweepRow[]) {
  const ok = rows.filter((r) => r.status === 200);
  const bad502 = rows.filter((r) => r.status === 502);
  const other = rows.filter((r) => r.status !== 200 && r.status !== 502);
  return {
    ok: ok.length,
    bad502,
    other,
    latencyP95: p95(rows.map((r) => r.ms)),
    latencyMax: rows.reduce((m, r) => Math.max(m, r.ms), 0),
  };
}

const LATENCY_BUDGET_MS = 3000;
// Concurrency picked to be meaningfully above the in-process HL fetch
// cap (MAX_CONCURRENT_FETCHES = 6 in services/hyperliquid.ts) so the
// test actually exercises queueing + the rate limiter, while staying
// below "every request in flight at once" (which would make CPU
// contention from the engine, not the rate limiter, dominate p95).
const SWEEP_CONCURRENCY = 12;

describe("levels: full-universe soak", () => {
  it(
    "cold-boot fan-out: every supported symbol returns 200; only upstream-unsupported coins 502",
    { timeout: 120_000 },
    async () => {
      const rows = await sweep(SWEEP_CONCURRENCY);
      const s = summarize(rows);
      const unexpected502 = s.bad502.filter((r) => !UNSUPPORTED_SYMBOLS.has(r.symbol));
      assert.equal(
        unexpected502.length, 0,
        `Unexpected 502s on supported symbols: ${JSON.stringify(unexpected502)}`,
      );
      assert.equal(
        s.other.length, 0,
        `Unexpected non-200/502 responses: ${JSON.stringify(s.other)}`,
      );
      const expectedOk = (SYMBOLS.length - UNSUPPORTED_SYMBOLS.size) * INTERVALS.length;
      assert.equal(
        s.ok, expectedOk,
        `Expected ${expectedOk} 200s, got ${s.ok} (502s: ${s.bad502.length})`,
      );
      assert.ok(
        s.latencyP95 < LATENCY_BUDGET_MS,
        `cold p95 ${s.latencyP95.toFixed(0)}ms exceeds ${LATENCY_BUDGET_MS}ms budget (max ${s.latencyMax.toFixed(0)}ms)`,
      );
    },
  );

  it(
    "after periodic-warmer uptime: cache + SWR keep the universe healthy under the same load",
    { timeout: 120_000 },
    async () => {
      // Simulate the production warmer (`scheduleNormalizedLevelsRefresh`
      // in `index.ts`) for the full universe. We don't actually wait
      // five minutes; one tick of the underlying TtlCache scheduler is
      // enough to prove the warm path stays green under repeated load.
      const { scheduleLevelsRefresh } = await import("../services/orchestrator");
      for (const sym of SYMBOLS) {
        if (UNSUPPORTED_SYMBOLS.has(sym)) continue;
        const coin = sym.replace(/USDT$/, "");
        for (const itv of INTERVALS) scheduleLevelsRefresh(coin, itv.toLowerCase());
      }
      // Give the warmer a moment to repopulate caches (its first tick
      // fires immediately, but it runs async — wait for one event-loop
      // settle plus a small slack window).
      await new Promise((r) => setTimeout(r, 750));

      const rows = await sweep(SWEEP_CONCURRENCY);
      const s = summarize(rows);
      const unexpected502 = s.bad502.filter((r) => !UNSUPPORTED_SYMBOLS.has(r.symbol));
      assert.equal(
        unexpected502.length, 0,
        `Unexpected 502s after warmup: ${JSON.stringify(unexpected502)}`,
      );
      assert.ok(
        s.latencyP95 < LATENCY_BUDGET_MS,
        `warm p95 ${s.latencyP95.toFixed(0)}ms exceeds ${LATENCY_BUDGET_MS}ms budget (max ${s.latencyMax.toFixed(0)}ms)`,
      );
    },
  );
});
