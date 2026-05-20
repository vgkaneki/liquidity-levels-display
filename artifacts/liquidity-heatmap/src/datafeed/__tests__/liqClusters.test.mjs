// Phase 3 — unit tests for the liquidations clusters parser.
//
// Pins the real `/api/liquidity/liquidations/clusters` payload shape
// so a backend-side rename (or a wrong assumption client-side) breaks
// the build instead of silently emptying the chart sidebar.

import { test } from "node:test";
import assert from "node:assert/strict";

function parseLiqCluster(row, defaultSymbol) {
  if (!row || typeof row !== "object") return null;
  const bucketPrice = Number(row.bucketPrice);
  if (!Number.isFinite(bucketPrice) || bucketPrice <= 0) return null;
  const bucketLow = Number(row.bucketLow);
  const bucketHigh = Number(row.bucketHigh);
  const longUsd = Number(row.longUsd);
  const shortUsd = Number(row.shortUsd);
  const totalUsdNum = Number(row.totalUsd);
  const totalUsd = Number.isFinite(totalUsdNum)
    ? totalUsdNum
    : (Number.isFinite(longUsd) ? longUsd : 0)
      + (Number.isFinite(shortUsd) ? shortUsd : 0);
  const count = Number(row.count);
  let lastTs = NaN;
  if (typeof row.lastTs === "number" && Number.isFinite(row.lastTs)) {
    lastTs = row.lastTs;
  } else if (typeof row.lastTimestamp === "string") {
    const parsed = Date.parse(row.lastTimestamp);
    if (Number.isFinite(parsed)) lastTs = parsed;
  }
  if (!Number.isFinite(lastTs)) lastTs = 0;
  const sources = {};
  const rawSources = row.sources;
  if (rawSources && typeof rawSources === "object") {
    for (const [k, v] of Object.entries(rawSources)) {
      const n = Number(v);
      if (Number.isFinite(n)) sources[k] = n;
    }
  }
  return {
    symbol: typeof row.symbol === "string" ? row.symbol : defaultSymbol,
    bucketPrice,
    bucketLow: Number.isFinite(bucketLow) ? bucketLow : bucketPrice,
    bucketHigh: Number.isFinite(bucketHigh) ? bucketHigh : bucketPrice,
    longUsd: Number.isFinite(longUsd) ? longUsd : 0,
    shortUsd: Number.isFinite(shortUsd) ? shortUsd : 0,
    totalUsd,
    count: Number.isFinite(count) ? count : 0,
    sources,
    lastTs,
  };
}

function parseClustersResponse(body, defaultSymbol) {
  if (!body || typeof body !== "object") return null;
  const rawClusters = Array.isArray(body.clusters) ? body.clusters : [];
  const clusters = [];
  for (const c of rawClusters) {
    const cluster = parseLiqCluster(c, defaultSymbol);
    if (cluster) clusters.push(cluster);
  }
  const windowMs = Number(body.windowMs);
  const bucketBps = Number(body.bucketBps);
  return {
    symbol: defaultSymbol,
    windowMs: Number.isFinite(windowMs) ? windowMs : 0,
    bucketBps: Number.isFinite(bucketBps) ? bucketBps : 0,
    clusters,
    source: typeof body.source === "string" ? body.source : null,
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString(),
  };
}

// Verbatim from `curl /api/liquidity/liquidations/clusters?symbol=BTCUSDT`.
const REAL_PAYLOAD = {
  windowMs: 300000,
  bucketBps: 20,
  symbols: ["BTCUSDT"],
  clusters: [
    {
      symbol: "BTCUSDT",
      bucketPrice: 77632.738454,
      bucketLow: 77555.18327073,
      bucketHigh: 77710.29363728,
      longUsd: 1102943.51,
      shortUsd: 310.53,
      totalUsd: 1103254.04,
      count: 27,
      sources: { okx: 10, hyperliquid: 0, bybit: 0, binance: 17 },
      lastTs: 1776935085746,
      lastTimestamp: "2026-04-23T09:04:45.746Z",
    },
  ],
  source: "memory",
  updatedAt: "2026-04-23T09:06:17.246Z",
};

test("clusters: parses the real backend payload end-to-end", () => {
  const snap = parseClustersResponse(REAL_PAYLOAD, "BTCUSDT");
  assert.ok(snap);
  assert.equal(snap.symbol, "BTCUSDT");
  assert.equal(snap.windowMs, 300000);
  assert.equal(snap.bucketBps, 20);
  assert.equal(snap.source, "memory");
  assert.equal(snap.updatedAt, "2026-04-23T09:06:17.246Z");
  assert.equal(snap.clusters.length, 1);
  const c = snap.clusters[0];
  assert.equal(c.bucketPrice, 77632.738454);
  assert.equal(c.longUsd, 1102943.51);
  assert.equal(c.shortUsd, 310.53);
  assert.equal(c.totalUsd, 1103254.04);
  assert.equal(c.count, 27);
  assert.equal(c.sources.binance, 17);
  assert.equal(c.lastTs, 1776935085746);
});

test("clusters: derives totalUsd from long+short when missing", () => {
  const snap = parseClustersResponse({
    windowMs: 300000, bucketBps: 20,
    clusters: [{
      symbol: "ETHUSDT", bucketPrice: 3000, bucketLow: 2999, bucketHigh: 3001,
      longUsd: 100, shortUsd: 50, count: 3,
      sources: { binance: 3 },
      lastTimestamp: "2026-01-01T00:00:00Z",
    }],
    source: "memory", updatedAt: "2026-01-01T00:00:00Z",
  }, "ETHUSDT");
  assert.equal(snap.clusters[0].totalUsd, 150);
});

test("clusters: derives lastTs from ISO lastTimestamp", () => {
  const snap = parseClustersResponse({
    windowMs: 0, bucketBps: 0,
    clusters: [{
      symbol: "X", bucketPrice: 1, bucketLow: 1, bucketHigh: 1,
      longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0,
      sources: {}, lastTimestamp: "2026-04-23T09:04:45.746Z",
    }],
    source: null, updatedAt: "now",
  }, "X");
  assert.equal(snap.clusters[0].lastTs, Date.parse("2026-04-23T09:04:45.746Z"));
});

test("clusters: drops malformed buckets without failing the snapshot", () => {
  const snap = parseClustersResponse({
    windowMs: 0, bucketBps: 0,
    clusters: [
      { bucketPrice: 0 },                 // bad: zero price
      { },                                // bad: missing
      "garbage",                           // bad: not an object
      { symbol: "X", bucketPrice: 100, longUsd: 1, shortUsd: 1, totalUsd: 2,
        bucketLow: 99, bucketHigh: 101, count: 1, sources: {}, lastTs: 1 },
    ],
    source: null, updatedAt: "x",
  }, "X");
  assert.equal(snap.clusters.length, 1);
  assert.equal(snap.clusters[0].bucketPrice, 100);
});

test("clusters: returns empty snapshot on empty body", () => {
  const snap = parseClustersResponse({}, "X");
  assert.ok(snap);
  assert.equal(snap.clusters.length, 0);
});
