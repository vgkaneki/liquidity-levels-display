import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetLiquidityHeatmapQueryParams,
  GetOrderbookQueryParams,
  GetSymbolsQueryParams,
  GetLiquidationsQueryParams,
  GetCandlesQueryParams,
} from "@workspace/api-zod";
import {
  buildHeatLevels,
  buildOrderbookLevels,
} from "./data";
import * as okx from "./exchanges/okx";
import * as hl from "./exchanges/hyperliquid";
import * as live from "./exchanges/live";
import { fetchCandlesSourced, fetchCandlesSourcedRange } from "../../services/candleSource";
import { getLiquidations as getOkxLiquidations, getRecentLiquidationsAcross } from "./exchanges/okx-liq-ws";
import { getHlLiquidations, getRecentHlLiquidationsAcross } from "./exchanges/hl-liq-ws";
import { getBybitLiquidations, getRecentBybitLiquidationsAcross } from "./exchanges/bybit-liq-ws";
import { getBinanceLiquidations, getRecentBinanceLiquidationsAcross } from "./exchanges/binance-liq-ws";
import { toobitEnabled } from "../../middlewares/toobitGate";
import { pushOrderbookSnapshot, getSmoothedOrderbook } from "./book-history";
import { getCachedLevelsAndRecord } from "../../services/levelsHost";
import { logger } from "../../lib/logger";
import { getCached, setCache } from "./exchanges/cache";
import { listActive, okxStore, hlStore } from "./exchanges/ws-store";
import { getAnalytics, analyticsStoreStats } from "./analytics-store";
import { getClustersFromDb } from "../../services/liquidationHistory/persistence";
import * as symbolRegistry from "../../services/symbolRegistry";
import { logDisagreement } from "../../services/symbolRegistry/disagreementLog";

const router: IRouter = Router();

// foregroundApiMicrocacheV1: tiny in-process REST cache for bursty live visual
// endpoints. The chart/DOM/Bookmap can ask for the same heatmap/orderbook
// snapshot multiple times during mount, panel remounts, or mobile layout
// changes. A 350ms cache coalesces those bursts without making trading data
// stale in practice. This is route transport only: protected engines, formulas,
// confluence, scoring, DOM math, Bookmap math, and level placement are untouched.
type ForegroundRestCacheEntry = {
  status: number;
  payload: unknown;
  expiresAt: number;
  headers?: Record<string, string>;
};
const FOREGROUND_REST_TTL_MS = Math.max(
  100,
  Number(process.env["FOREGROUND_REST_TTL_MS"] ?? "350") || 350,
);
const FOREGROUND_REST_CACHE_MAX = 512;
const foregroundRestCache = new Map<string, ForegroundRestCacheEntry>();

function foregroundRestKey(req: Request): string {
  const params = new URLSearchParams();
  const entries = Object.entries(req.query).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value != null) {
      params.set(key, String(value));
    }
  }
  return req.path + "?" + params.toString();
}

function getForegroundRestCache(key: string): ForegroundRestCacheEntry | null {
  const entry = foregroundRestCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    foregroundRestCache.delete(key);
    return null;
  }
  return entry;
}

function setForegroundRestCache(
  key: string,
  status: number,
  payload: unknown,
  headers?: Record<string, string>,
): void {
  while (foregroundRestCache.size >= FOREGROUND_REST_CACHE_MAX) {
    const oldest = foregroundRestCache.keys().next().value;
    if (oldest === undefined) break;
    foregroundRestCache.delete(oldest);
  }
  foregroundRestCache.set(key, {
    status,
    payload,
    headers,
    expiresAt: Date.now() + FOREGROUND_REST_TTL_MS,
  });
}

function sendForegroundRestCache(res: Response, entry: ForegroundRestCacheEntry): void {
  if (entry.headers) {
    for (const [key, value] of Object.entries(entry.headers)) res.setHeader(key, value);
  }
  res.setHeader("X-Foreground-Rest-Cache", "HIT");
  res.status(entry.status).json(entry.payload);
}

// Default basket used when callers ask for "everything" without naming a
// symbol (rekt feed, cluster aggregator). These are canonical perp tickers
// that exist on every exchange we read from, so the realtime stores will
// reliably have events for them.
const DEFAULT_LIQUIDATION_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
];

function normalizeSymbol(raw: string): string {
  return raw.replace(/-/g, "").toUpperCase();
}

// Lazy-require the Toobit WS module so the dependency stays dormant
// when the toobit gate is off (matches the loadToobitUniverse pattern
// further down in this file).
let toobitWsModule: typeof import("./exchanges/toobit-ws") | null = null;
function getToobitWs(): typeof import("./exchanges/toobit-ws") | null {
  if (!toobitEnabled()) return null;
  if (toobitWsModule) return toobitWsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    toobitWsModule = require("./exchanges/toobit-ws") as typeof import("./exchanges/toobit-ws");
    return toobitWsModule;
  } catch {
    return null;
  }
}

async function getRealOrderbook(
  sym: string,
  depth: number
): Promise<{
  bids: [number, number][];
  asks: [number, number][];
  source: string;
} | null> {
  // Phase 1 SymbolRegistry — book routing chain comes from the registry
  // (default OKX→HL→Toobit, env-overridable via BOOK_ROUTING). Symbols
  // the registry knows aren't listed on a given exchange are skipped
  // outright, avoiding pointless upstream calls. When the registry is
  // cold (returns "unknown") we fall through to the default chain so
  // boot-time behavior matches today's hardcoded order.
  const fromChain = symbolRegistry.fallbackChain(sym, "book");
  const chain = fromChain.length > 0 ? fromChain : (["okx", "hl", "toobit"] as const);

  for (const ex of chain) {
    if (ex === "okx") {
      const okxBook = await live.getOkxOrderbook(sym);
      if (okxBook) {
        const bids = depth < okxBook.bids.length ? okxBook.bids.slice(0, depth) : okxBook.bids;
        const asks = depth < okxBook.asks.length ? okxBook.asks.slice(0, depth) : okxBook.asks;
        return {
          bids: bids.map((l) => [l.price, l.size]),
          asks: asks.map((l) => [l.price, l.size]),
          source: "okx",
        };
      }
    } else if (ex === "hl") {
      const hlBook = await live.getHlOrderbook(sym);
      if (hlBook) {
        return {
          bids: hlBook.bids.map((l) => [l.price, l.size]),
          asks: hlBook.asks.map((l) => [l.price, l.size]),
          source: "hyperliquid",
        };
      }
    } else if (ex === "toobit") {
      // Toobit tier: ~273 symbols are Toobit-only. ensureSubscribed is
      // fire-and-forget so the WS subscription warms on first request.
      const tb = getToobitWs();
      if (tb && tb.isToobitSupported(sym)) {
        tb.ensureSubscribed(sym);
        const tbBook = tb.getToobitBook(sym);
        if (tbBook && tbBook.bids.length > 0 && tbBook.asks.length > 0) {
          const bids = depth < tbBook.bids.length ? tbBook.bids.slice(0, depth) : tbBook.bids;
          const asks = depth < tbBook.asks.length ? tbBook.asks.slice(0, depth) : tbBook.asks;
          return { bids, asks, source: "toobit" };
        }
      }
    }
  }
  return null;
}

async function getRealTicker(sym: string): Promise<{
  markPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  priceChange24h: number;
  source: string;
  // "mark" only when the venue publishes a true funding mark (HL).
  // "last" for last-traded fallbacks (Toobit / OKX). Lets the chart
  // label the price field honestly instead of always saying "Mark Price".
  priceType: "mark" | "last";
} | null> {
  // Hyperliquid-first so the REST snapshot agrees with the candle source
  // ladder (HL→Toobit; OKX is not in the candle path) and the WS heatmap
  // builder (HL→Toobit→OKX for price). Funding / OI / volume / 24h change
  // are bundled from the same venue as the price so the price card stays
  // internally consistent — never a Hyperliquid mark next to OKX volume.
  const hlAsset = await live.getHlAsset(sym);
  if (hlAsset && hlAsset.markPx > 0) {
    const change =
      hlAsset.prevDayPx > 0
        ? ((hlAsset.markPx - hlAsset.prevDayPx) / hlAsset.prevDayPx) * 100
        : 0;
    return {
      markPrice: hlAsset.markPx,
      fundingRate: hlAsset.funding,
      openInterest: hlAsset.openInterest * hlAsset.markPx,
      volume24h: hlAsset.dayNtlVlm,
      priceChange24h: parseFloat(change.toFixed(2)),
      source: "hyperliquid",
      priceType: "mark",
    };
  }

  // Toobit fallback. Funding/OI aren't published on the WS feed, so we
  // surface 0 for those (the chart already tolerates 0 and shows "-").
  // Volume is reported as base units, scaled to USD notional via last.
  const tb = getToobitWs();
  if (tb && tb.isToobitSupported(sym)) {
    tb.ensureSubscribed(sym);
    const t = tb.getToobitTicker(sym);
    if (t && t.last > 0) {
      const open = t.open24h ?? 0;
      const change = open > 0 ? ((t.last - open) / open) * 100 : 0;
      return {
        markPrice: t.last,
        fundingRate: 0,
        openInterest: 0,
        volume24h: (t.volume24h ?? 0) * t.last,
        priceChange24h: parseFloat(change.toFixed(2)),
        source: "toobit",
        priceType: "last",
      };
    }
  }

  // OKX last resort — full slate of funding/OI/volume but the price is
  // last-traded, not a true mark. UI surfaces this as a "Last" label.
  const ticker = await live.getOkxTicker(sym);
  if (ticker) {
    const [funding, oi] = await Promise.all([
      live.getOkxFunding(sym),
      live.getOkxOI(sym),
    ]);

    const last = parseFloat(ticker.last);
    const open24h = parseFloat(ticker.open24h);
    const change = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;

    return {
      markPrice: last,
      fundingRate: funding?.fundingRate ?? 0,
      openInterest: oi?.oiUsd ?? 0,
      volume24h: parseFloat(ticker.volCcy24h) * last,
      priceChange24h: parseFloat(change.toFixed(2)),
      source: "okx",
      priceType: "last",
    };
  }

  return null;
}

// --- Unioned perp universe (OKX + HL + Toobit) ---
//
// Source of truth for the symbol catalog used by the frontend dropdown,
// the scanner, and any future "scan everything" feature. Deduped on a
// canonical `${BASE}USDT` key. Each entry advertises which exchanges
// list the symbol so callers can route reads accordingly. 24h volume
// is taken from whichever exchange has the freshest number (OKX > HL >
// Toobit-WS-cache), with 0 used as a sentinel when none is available.

interface UniverseEntry {
  symbol: string;          // canonical, e.g. "BTCUSDT"
  base: string;            // e.g. "BTC"
  exchanges: ("okx" | "hyperliquid" | "toobit")[];
  volume24h: number;       // best available 24h notional in USD
}

interface UniverseSnapshot {
  entries: UniverseEntry[];
  builtAt: number;
}

const UNIVERSE_CACHE_TTL_MS = 30_000;
let universeCache: UniverseSnapshot | null = null;
let universeInflight: Promise<UniverseSnapshot> | null = null;

function loadToobitUniverse(): { uiSymbol: string; baseAsset: string }[] {
  if (!toobitEnabled()) return [];
  try {
    // Lazy-require keeps the module dormant when the flag is off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./exchanges/toobit-ws") as typeof import("./exchanges/toobit-ws");
    return mod.listUniverse().map((u) => ({
      uiSymbol: u.uiSymbol,
      baseAsset: u.baseAsset,
    }));
  } catch {
    return [];
  }
}

function getToobitTickerVolume(uiSymbol: string): number {
  if (!toobitEnabled()) return 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./exchanges/toobit-ws") as typeof import("./exchanges/toobit-ws");
    const t = mod.getToobitTicker(uiSymbol);
    if (!t) return 0;
    const last = t.last ?? 0;
    const vol = t.volume24h ?? 0;
    return Number.isFinite(last) && Number.isFinite(vol) ? last * vol : 0;
  } catch {
    return 0;
  }
}

async function buildUniverseSnapshot(): Promise<UniverseSnapshot> {
  const [okxList, hlAssets] = await Promise.all([
    okx.fetchInstruments(),
    hl.fetchAllAssets(),
  ]);
  const toobitList = loadToobitUniverse();

  const map = new Map<string, UniverseEntry>();

  if (okxList) {
    for (const inst of okxList) {
      const sym = inst.symbol;
      if (!sym) continue;
      const base = inst.baseAsset || sym.replace(/USDT$/, "");
      let entry = map.get(sym);
      if (!entry) {
        entry = { symbol: sym, base, exchanges: [], volume24h: 0 };
        map.set(sym, entry);
      }
      if (!entry.exchanges.includes("okx")) entry.exchanges.push("okx");
    }
  }

  if (hlAssets) {
    for (const [coin, ctx] of hlAssets) {
      const base = coin.toUpperCase();
      const sym = `${base}USDT`;
      let entry = map.get(sym);
      if (!entry) {
        entry = { symbol: sym, base, exchanges: [], volume24h: 0 };
        map.set(sym, entry);
      }
      if (!entry.exchanges.includes("hyperliquid")) entry.exchanges.push("hyperliquid");
      // HL gives notional volume directly. Use it if OKX hasn't filled in.
      if (entry.volume24h === 0 && Number.isFinite(ctx.dayNtlVlm)) {
        entry.volume24h = ctx.dayNtlVlm;
      }
    }
  }

  for (const t of toobitList) {
    const sym = t.uiSymbol;
    if (!sym || !/^[A-Z0-9]+USDT$/.test(sym)) continue;
    let entry = map.get(sym);
    if (!entry) {
      entry = { symbol: sym, base: t.baseAsset, exchanges: [], volume24h: 0 };
      map.set(sym, entry);
    }
    if (!entry.exchanges.includes("toobit")) entry.exchanges.push("toobit");
    if (entry.volume24h === 0) {
      const v = getToobitTickerVolume(sym);
      if (v > 0) entry.volume24h = v;
    }
  }

  // Backfill OKX 24h volume from any cached tickers we already have
  // (the WS layer tends to fill these for the warm/pinned set).
  for (const entry of map.values()) {
    if (entry.volume24h !== 0) continue;
    if (!entry.exchanges.includes("okx")) continue;
    // No direct sync accessor; volume stays 0 here and will sort to the
    // bottom of "by-volume" lists, which is fine — those symbols just
    // haven't traded enough for us to have a number on hand.
  }

  const entries = Array.from(map.values()).sort(
    (a, b) => b.volume24h - a.volume24h || a.symbol.localeCompare(b.symbol),
  );

  return { entries, builtAt: Date.now() };
}

async function getUnionUniverse(): Promise<UniverseSnapshot> {
  const now = Date.now();
  if (universeCache && now - universeCache.builtAt < UNIVERSE_CACHE_TTL_MS) {
    return universeCache;
  }
  if (universeInflight) return universeInflight;
  universeInflight = (async () => {
    const snap = await buildUniverseSnapshot();
    universeCache = snap;
    return snap;
  })().finally(() => {
    universeInflight = null;
  });
  return universeInflight;
}

// Synchronous membership check for callers that need fast-fail behavior.
// Returns:
//   "yes"     → symbol is in the union of OKX + HL + Toobit instruments.
//   "no"      → cache is fresh AND symbol is not in any exchange.
//   "unknown" → cache is cold or stale; caller must fall through to the
//               slow path (we never false-negative). Triggers a background
//               warm so the next caller gets a definitive answer.
//
// This powers the unsupported-symbol fast-path in /api/levels: when a
// user enters e.g. "FOOUSDT" we can reject in <5 ms instead of waiting
// 7-21 s for the orchestrator to discover that no upstream has bars
// for it. Pure metadata check — no engine state read or written.
function isSymbolListedLegacy(norm: string): "yes" | "no" | "unknown" {
  const STALE_OK_MS = 5 * 60_000;
  if (universeCache && Date.now() - universeCache.builtAt < STALE_OK_MS) {
    for (const e of universeCache.entries) {
      if (e.symbol === norm || e.base === norm) return "yes";
    }
    const noQuote = norm.replace(/USDT$/, "");
    if (noQuote !== norm) {
      for (const e of universeCache.entries) {
        if (e.base === noQuote) return "yes";
      }
    }
    if (Date.now() - universeCache.builtAt >= UNIVERSE_CACHE_TTL_MS) {
      void getUnionUniverse().catch(() => {});
    }
    return "no";
  }
  void getUnionUniverse().catch(() => {});
  return "unknown";
}

export function isSymbolListed(rawSymbol: string): "yes" | "no" | "unknown" {
  const norm = normalizeSymbol(rawSymbol);
  if (!norm) return "unknown";
  // Phase 1 SymbolRegistry — primary path. Legacy union-cache scan is
  // retained for one release as a safety backstop; any divergence is
  // logged so we can confidently drop the legacy path next release.
  const fromRegistry = symbolRegistry.isListed(norm);
  const fromLegacy = isSymbolListedLegacy(norm);
  if (
    fromRegistry !== fromLegacy &&
    fromRegistry !== "unknown" &&
    fromLegacy !== "unknown"
  ) {
    logDisagreement("isSymbolListed", norm, fromRegistry, fromLegacy);
  }
  // Prefer registry, but defer to legacy when the registry hasn't
  // populated yet — preserves today's behavior in the cold-boot window.
  if (fromRegistry === "unknown" && fromLegacy !== "unknown") {
    return fromLegacy;
  }
  return fromRegistry;
}

// Eager warm called from boot so the membership gate is effective from
// the first user request rather than after the first universe fetch.
// Best-effort: errors are logged but not fatal.
export async function warmUniverseCache(): Promise<void> {
  try {
    const snap = await getUnionUniverse();
    logger.info(
      { count: snap.entries.length, builtAt: new Date(snap.builtAt).toISOString() },
      "universe cache warmed",
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "universe cache warm failed");
  }
}

// Phase 3 (IDatafeed) — server clock for chart clock-skew compensation.
// Trivial endpoint, intentionally additive: the future TradingView
// adapter calls this once at chart mount to align local time with the
// api-server's wall clock, which avoids "future bar" / "missing live
// bar" rendering glitches when the user's machine clock drifts. Must
// reflect the api-server clock directly — do NOT derive from any other
// timestamp source. Set no-store so intermediaries can't cache it.
router.get("/liquidity/server-time", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ now: Date.now() });
});

router.get("/liquidity/universe", async (_req, res): Promise<void> => {
  const snap = await getUnionUniverse();
  res.json({
    count: snap.entries.length,
    builtAt: new Date(snap.builtAt).toISOString(),
    toobitEnabled: toobitEnabled(),
    symbols: snap.entries,
  });
});

router.get("/liquidity/heatmap", async (req, res): Promise<void> => {
  const parsed = GetLiquidityHeatmapQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { symbol, levels = 50 } = parsed.data;
  const clampedLevels = Math.min(500, Math.max(10, Number(levels)));
  const sym = normalizeSymbol(symbol);
  const foregroundKey = foregroundRestKey(req);
  const foregroundCached = getForegroundRestCache(foregroundKey);
  if (foregroundCached) {
    sendForegroundRestCache(res, foregroundCached);
    return;
  }
  live.touchSymbol(sym);

  const [realBook, realTicker] = await Promise.all([
    getRealOrderbook(sym, 300),
    getRealTicker(sym),
  ]);

  const realBookHasDepth =
    !!realBook && realBook.bids.length > 0 && realBook.asks.length > 0;

  // Honest empty state: when no exchange has a live book or ticker for
  // this symbol, return 503 instead of synthesizing fake depth. The
  // frontend renders a "no live data" message off this signal.
  if (!realTicker || !realBookHasDepth) {
    res.status(503).json({
      error: "no live data",
      symbol: sym,
      hasTicker: !!realTicker,
      hasBook: realBookHasDepth,
    });
    return;
  }

  const bids = realBook!.bids;
  const asks = realBook!.asks;
  const markPrice = realTicker.markPrice;
  const fundingRate = realTicker.fundingRate;
  const openInterest = realTicker.openInterest;
  const volume24h = realTicker.volume24h;
  const priceChange24h = realTicker.priceChange24h;
  const exchange = realBook!.source === realTicker.source
    ? realTicker.source
    : `${realBook!.source}+${realTicker.source}`;

  // Index price equals mark price when no separate index feed is wired
  // up. We deliberately do NOT add jitter here — that was synthetic
  // noise. UI consumers tolerate indexPrice === markPrice.
  const indexPrice = markPrice;

  // Anti-spoof: feed `buildHeatLevels` a time-weighted snapshot built from
  // the last ~60s of orderbooks rather than the single live one. Walls that
  // appeared and vanished decay out; persistent walls survive intact. See
  // book-history.ts for the smoothing algorithm.
  pushOrderbookSnapshot(sym, bids, asks);
  const smoothed = getSmoothedOrderbook(sym, markPrice);
  const heatBids = smoothed?.bids ?? bids;
  const heatAsks = smoothed?.asks ?? asks;
  const heatLevels = buildHeatLevels(heatBids, heatAsks, markPrice, clampedLevels);

  // Map the ticker source string onto the same priceSource enum the
  // WS hub uses so the chart's header chip + axis label can read one
  // consistent contract regardless of whether the payload arrived via
  // REST snapshot or WS delta. priceType comes through unchanged.
  const priceSource: "hyperliquid" | "toobit" | "okx" =
    realTicker.source === "hyperliquid" ? "hyperliquid"
    : realTicker.source === "toobit" ? "toobit"
    : "okx";

  const payload = {
    symbol: sym,
    exchange,
    priceSource,
    priceType: realTicker.priceType,
    markPrice,
    indexPrice,
    fundingRate: parseFloat(fundingRate.toFixed(6)),
    openInterest,
    volume24h,
    priceChange24h,
    levels: heatLevels,
    updatedAt: new Date().toISOString(),
  };
  res.setHeader("X-Foreground-Rest-Cache", "MISS");
  setForegroundRestCache(foregroundKey, 200, payload, { "X-Foreground-Rest-Cache": "HIT" });
  res.json(payload);
});

router.get("/liquidity/orderbook", async (req, res): Promise<void> => {
  const parsed = GetOrderbookQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { symbol, depth = 100 } = parsed.data;
  const sym = normalizeSymbol(symbol);
  const foregroundKey = foregroundRestKey(req);
  const foregroundCached = getForegroundRestCache(foregroundKey);
  if (foregroundCached) {
    sendForegroundRestCache(res, foregroundCached);
    return;
  }
  live.touchSymbol(sym);

  const realBook = await getRealOrderbook(sym, Number(depth));

  if (!realBook || realBook.bids.length === 0 || realBook.asks.length === 0) {
    res.status(503).json({ error: "no live orderbook", symbol: sym });
    return;
  }

  const exchange = realBook.source;
  const obBids = buildOrderbookLevels(realBook.bids);
  const obAsks = buildOrderbookLevels(realBook.asks);

  const bestBid = obBids[0]?.price ?? 0;
  const bestAsk = obAsks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;

  const payload = {
    symbol: sym,
    exchange,
    bids: obBids,
    asks: obAsks,
    spread,
    spreadPct: parseFloat(spreadPct.toFixed(4)),
    updatedAt: new Date().toISOString(),
  };
  res.setHeader("X-Foreground-Rest-Cache", "MISS");
  setForegroundRestCache(foregroundKey, 200, payload, { "X-Foreground-Rest-Cache": "HIT" });
  res.json(payload);
});

router.get("/liquidity/symbols", async (req, res): Promise<void> => {
  const parsed = GetSymbolsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const okxInstruments = await okx.fetchInstruments();

  if (okxInstruments && okxInstruments.length > 0) {
    const hlAssets = await hl.fetchAllAssets();

    const topTickers = await Promise.all(
      okxInstruments.slice(0, 50).map(async (inst) => {
        const hlCoin = inst.baseAsset.toUpperCase();
        const hlData = hlAssets?.get(hlCoin);
        if (hlData && hlData.markPx > 0) return { inst, hlData, okxTicker: null };
        const ticker = await okx.fetchTicker(inst.symbol);
        return { inst, hlData: null, okxTicker: ticker };
      })
    );

    const restInstruments = okxInstruments.slice(50).map((inst) => {
      const hlCoin = inst.baseAsset.toUpperCase();
      const hlData = hlAssets?.get(hlCoin);
      return { inst, hlData: hlData && hlData.markPx > 0 ? hlData : null, okxTicker: null };
    });

    const allEntries = [...topTickers, ...restInstruments];

    const symbols = allEntries
      .map(({ inst, hlData, okxTicker }) => {
        const sym = inst.symbol;

        let markPrice = 0;
        let priceChange24h = 0;
        let volume24h = 0;
        let openInterest = 0;

        if (hlData) {
          markPrice = hlData.markPx;
          priceChange24h = hlData.prevDayPx > 0
            ? parseFloat((((hlData.markPx - hlData.prevDayPx) / hlData.prevDayPx) * 100).toFixed(2))
            : 0;
          volume24h = hlData.dayNtlVlm;
          openInterest = hlData.openInterest * hlData.markPx;
        } else if (okxTicker) {
          markPrice = parseFloat(okxTicker.last);
          const open24h = parseFloat(okxTicker.open24h);
          priceChange24h = open24h > 0
            ? parseFloat((((markPrice - open24h) / open24h) * 100).toFixed(2))
            : 0;
          volume24h = parseFloat(okxTicker.volCcy24h) * markPrice;
        }

        // No live data path available — skip rather than fabricate one.
        if (markPrice <= 0) return null;

        // Liquidity score derived from real 24h notional, matching the
        // tiers the watchlist UI groups by (Top / Major / Mid / Long-tail).
        const liquidityScore =
          volume24h >= 1e9 ? 5.0 :
          volume24h >= 1e8 ? 4.0 :
          volume24h >= 1e7 ? 3.0 :
          volume24h >= 1e6 ? 2.0 : 1.0;

        return {
          symbol: sym,
          baseAsset: inst.baseAsset,
          quoteAsset: "USDT",
          markPrice,
          priceChange24h,
          volume24h,
          openInterest,
          liquidityScore,
        };
      })
      .filter(Boolean);

    res.json(symbols);
    return;
  }

  // No real exchange instruments — no honest data to return.
  res.status(503).json({ error: "no live exchange instruments" });
});

router.get("/liquidity/market-overview", async (_req, res): Promise<void> => {
  // Shared compute path with the WS market:overview channel so REST and WS
  // never disagree about totals. The cached wrapper de-dupes concurrent
  // callers and serves a 30s in-memory snapshot — both REST and WS hit the
  // same single-flight, so there is one compute every 30s instead of one
  // compute per request.
  const { getMarketOverviewCached, getMarketOverviewCacheAgeMs } = await import(
    "../../services/marketOverview"
  );
  const payload = await getMarketOverviewCached();
  const ageMs = getMarketOverviewCacheAgeMs();
  if (ageMs != null) res.setHeader("X-Market-Overview-Age-Ms", String(ageMs));
  res.setHeader("Cache-Control", "public, max-age=0, stale-while-revalidate=30");
  res.json(payload);
});

// In-process response cache for /liquidity/candles. Keyed by
// symbol+interval+limit, with a short TTL on success and a separate
// "last-good" snapshot that survives indefinitely so we can serve a
// stale-but-real response when both upstreams are slow or down.
//
// This caps the blast radius of a Hyperliquid 500 spike: instead of every
// concurrent client waiting on the full HL→Toobit→OKX timeout chain, the
// first request pays that cost and the rest get the cached payload back
// in microseconds. Per-source `Promise.race` timeouts further bound the
// worst case so /api/liquidity/candles can never block the event loop
// for the 14s+ we were seeing during HL incidents.
type CandleRow = {
  timestamp: number; open: number; high: number; low: number; close: number; volume: number;
};
interface CandleCacheEntry {
  payload: { symbol: string; interval: string; candles: CandleRow[]; source: string };
  freshUntil: number;
  cachedAt: number;
}
// Discriminated outcome from the single-flight compute. The route uses
// `kind` to decide between 200 (ok), 404 (honest-empty: every upstream
// returned zero bars without throwing — symbol effectively unsupported),
// and 503 (errored: at least one upstream threw, treat as transient).
// Without this discrimination an upstream incident would be cached as
// a 5-minute "unsupported" 404, locking out a working symbol.
type CandleComputeOutcome =
  | { kind: "ok"; entry: CandleCacheEntry }
  | { kind: "honest-empty" }
  | { kind: "errored" };
const CANDLE_CACHE_TTL_MS = 30_000;
const CANDLE_LASTGOOD_TTL_MS = 5 * 60_000;
// Bounded to prevent unbounded growth from user-controlled cache keys
// (symbol|interval|limit). Map iteration order is insertion-order, so
// deleting the first key when at cap gives FIFO eviction — adequate for
// a route where the working set is tens of popular symbols, not thousands.
const CANDLE_CACHE_MAX_ENTRIES = 2_000;
const candleCache = new Map<string, CandleCacheEntry>();
const candleInflight = new Map<string, Promise<CandleComputeOutcome>>();

function clampCandleLimitForPressure(bar: string, requested: number): number {
  // foregroundCandlePressureV1
  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 200;
  const envOverride = Number(process.env.CANDLE_FOREGROUND_MAX_BARS ?? "0");
  if (Number.isFinite(envOverride) && envOverride > 0) {
    return Math.min(safeRequested, Math.max(50, Math.floor(envOverride)));
  }
  const upper = bar === "1M" ? 120
    : bar === "1W" ? 180
    : bar === "3D" ? 220
    : bar === "1D" ? 260
    : bar === "12H" ? 320
    : bar === "6H" ? 420
    : bar === "4H" ? 520
    : bar === "2H" ? 650
    : bar === "1H" ? 800
    : bar === "30m" ? 900
    : bar === "15m" ? 1_000
    : 1_200;
  return Math.min(safeRequested, upper);
}

function evictCandleCacheIfFull(): void {
  while (candleCache.size >= CANDLE_CACHE_MAX_ENTRIES) {
    const oldestKey = candleCache.keys().next().value;
    if (oldestKey === undefined) break;
    candleCache.delete(oldestKey);
  }
}

// Boot-time warm-up helper. The /api/liquidity/candles route memoizes
// against `candleCache` keyed by `${sym}|${bar}|${lim}`; a separate
// source-level cache lives inside services/candleSource. Without this
// helper, the boot warm-up populated only the source-level cache —
// which made the first user click return in ~0ms but still classify as
// "MISS / cold-miss" in headers and logs (because the route-level map
// was empty). This bridges the two so warmed pairs read accurately as
// "HIT / hot-hit". Keeps the same CandleRow transform the route uses
// inline so the cached payload shape is byte-identical.
export function primeCandleCache(
  symbol: string,
  bar: string,
  sourced: { candles: Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>; source: "hyperliquid" | "toobit" | "okx" },
  lim: number = 200,
): void {
  if (!sourced.candles || sourced.candles.length === 0) return;
  const sym = normalizeSymbol(symbol);
  const candles: CandleRow[] = sourced.candles.slice(-lim).map((c) => ({
    timestamp: c.t,
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  }));
  const cacheKey = `${sym}|${bar}|${lim}`;
  const entry: CandleCacheEntry = {
    payload: { symbol: sym, interval: bar, candles, source: sourced.source },
    freshUntil: Date.now() + CANDLE_CACHE_TTL_MS,
    cachedAt: Date.now(),
  };
  candleCache.delete(cacheKey);
  evictCandleCacheIfFull();
  candleCache.set(cacheKey, entry);
}

// CRITICAL — chart-load reliability fix (April 2026):
//
// Subset-tolerant cache lookup. The route cache is keyed on
// `${sym}|${bar}|${lim}` so a warmed entry for limit=10000 (chart) was
// previously a cache MISS for limit=200 (scanner) and vice-versa, even
// though the larger entry trivially contains the data the smaller
// request needs.
//
// This helper performs an exact-match lookup first (preserves the
// fast-path for the common case), then falls back to a prefix-scan for
// any entry of the same (sym,bar) whose cached `lim` is ≥ the requested
// `lim`. The closest larger entry is selected (to minimize slice cost
// and serve the freshest possible payload), the candles are sliced to
// the requested length, and the entry is returned with its original
// freshness/cachedAt windows preserved so SWR semantics still apply.
//
// Engine math is untouched: this is purely a transport-layer hit-rate
// optimization. The slice always preserves the most recent N bars,
// matching the route's ascending-time response contract.
function candleCacheLookup(sym: string, bar: string, lim: number): CandleCacheEntry | null {
  const exactKey = `${sym}|${bar}|${lim}`;
  const exact = candleCache.get(exactKey);
  if (exact) return exact;

  const prefix = `${sym}|${bar}|`;
  let best: CandleCacheEntry | null = null;
  let bestLim = Number.POSITIVE_INFINITY;
  for (const [k, v] of candleCache.entries()) {
    if (!k.startsWith(prefix)) continue;
    const cachedLim = Number(k.slice(prefix.length));
    if (!Number.isFinite(cachedLim)) continue;
    if (cachedLim >= lim && cachedLim < bestLim) {
      best = v;
      bestLim = cachedLim;
    }
  }
  if (!best) {
    // Last-resort: when no entry meets the requested lim, fall back to
    // the LARGEST available entry for this (sym,bar). Returning 5000
    // bars when the caller asked for 10000 is dramatically better UX
    // than failing — the chart renders with the history we have, and
    // the caller's request will populate the larger entry on its own
    // compute path. Without this branch, an upstream-cap mismatch
    // (e.g. chart asks 10000, HL returns max 5000, warm cached 5000)
    // would defeat the entire warm-up.
    let largest: CandleCacheEntry | null = null;
    let largestBars = -1;
    for (const [k, v] of candleCache.entries()) {
      if (!k.startsWith(prefix)) continue;
      if (v.payload.candles.length > largestBars) {
        largest = v;
        largestBars = v.payload.candles.length;
      }
    }
    return largest;
  }
  if (best.payload.candles.length <= lim) return best;
  return {
    payload: {
      ...best.payload,
      candles: best.payload.candles.slice(-lim),
    },
    freshUntil: best.freshUntil,
    cachedAt: best.cachedAt,
  };
}

function withCandlesTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

router.get("/liquidity/candles", async (req, res): Promise<void> => {
  const parsed = GetCandlesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { symbol, interval = "4H", limit = 200 } = parsed.data;
  const sym = normalizeSymbol(symbol);
  const bar = interval ?? "4H";
  const requestedLim = Number(limit);
  const lim = clampCandleLimitForPressure(bar, requestedLim);

  // Early-out for symbols that no upstream lists for candles. Without
  // this guard the request walks the full HL → OKX → Toobit fallback,
  // each upstream returns "no such pair", and the route eventually
  // emits a fast 503 ("no live candles") — which the client retries on
  // a 30s react-query schedule, producing the persistent APE-4H-503
  // spam we saw in the wild. Issuing 404 instead is honest about the
  // state ("we cannot serve this pair") and lets react-query's
  // shouldRetry default skip the retry storm.
  //
  // We use `isUnsupportedFor("candles")` — a routing-chain-scoped check
  // — instead of the global `isListed === "no"` (which required ALL
  // exchange snapshots to be fresh). The chain-scoped check returns
  // `true` ONLY when every chain exchange has a fresh, OK snapshot AND
  // none of them list the symbol; it returns `false` whenever any chain
  // exchange has errored, is stale, or lists the symbol — preserving
  // the discriminated behavior the spec requires:
  //   * clean unsupported / honest empty → 404 (no retry storm)
  //   * upstream error / timeout / rate-limit → 503 (transient,
  //     react-query may retry, NOT cached as unsupported)
  // This avoids the prior failure mode where a chronic HL 429 kept
  // `allFresh()` permanently false, which silently bypassed the 404
  // fast-path and turned every unsupported lookup into a 3.7s 503.
  // No engine math, scoring, or routing is changed.
  if (symbolRegistry.isUnsupportedFor(sym, "candles")) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(404).json({
      error: "unsupported symbol",
      detail: "No upstream lists this symbol for candles",
      symbol: sym,
      interval: bar,
    });
    return;
  }

  live.touchSymbol(sym);

  // Phase 3 (IDatafeed) — optional explicit time range. When the caller
  // passes valid `from`/`to` epoch-ms params, take a sibling fast-path
  // that fetches the bars in that window directly from the source's
  // range-aware path (HL native, Toobit derived). The legacy
  // limit-based path below is unchanged and still handles every existing
  // caller (chart shell, scanner, engines, warm-up). Range responses
  // bypass the route-level cache because their cache key shape is
  // disjoint and the source-level cache already coalesces concurrent
  // identical requests.
  const fromQRaw = req.query["from"];
  const toQRaw = req.query["to"];
  const fromQ = typeof fromQRaw === "string" ? Number(fromQRaw) : NaN;
  const toQ = typeof toQRaw === "string" ? Number(toQRaw) : NaN;
  const hasRange =
    Number.isFinite(fromQ) && Number.isFinite(toQ) && fromQ > 0 && toQ > fromQ;
  if (hasRange) {
    const hlInterval = HL_INTERVAL_MAP[bar] ?? bar;
    const coin = sym.replace(/USDT?$/, "");
    try {
      const sourced = await withCandlesTimeout(
        fetchCandlesSourcedRange(coin, hlInterval, fromQ, toQ),
        4000,
        "candle_source_range",
      );
      const candles: CandleRow[] = sourced.candles.map((c) => ({
        timestamp: c.t,
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      }));
      // No route-level caching for range responses; source-level cache
      // already memoizes the (coin,interval,from,to) triple.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Candles-Mode", "range");
      res.setHeader("X-Candles-Source", sourced.source);
      res.json({ symbol: sym, interval: bar, candles, source: sourced.source });
      return;
    } catch (err) {
      logger.warn(
        { symbol: sym, interval: bar, fromMs: fromQ, toMs: toQ, err: String(err) },
        "candles range fetch failed",
      );
      res.status(503).json({ error: "no live candles", symbol: sym, interval: bar });
      return;
    }
  }

  const cacheKey = `${sym}|${bar}|${lim}`;
  const now = Date.now();
  const t0 = process.hrtime.bigint();

  // Fast path: a fresh cached payload exists. Uses subset-tolerant
  // lookup so a single warmed entry serves all consumers regardless of
  // their requested `limit`.
  const cached = candleCacheLookup(sym, bar, lim);
  if (cached && cached.freshUntil > now) {
    // Standard SWR headers so the browser HTTP cache and any intermediary
    // can also leverage stale-while-revalidate, not just our in-process
    // cache. max-age = remaining freshness; stale-while-revalidate spans
    // the rest of the last-good window.
    const maxAgeS = Math.max(0, Math.floor((cached.freshUntil - now) / 1000));
    const swrS = Math.max(0, Math.floor(CANDLE_LASTGOOD_TTL_MS / 1000));
    res.setHeader("Cache-Control", `public, max-age=${maxAgeS}, stale-while-revalidate=${swrS}`);
    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Candles-Limit", String(lim));
    // True hot-hit: served from in-process cache without any await on
    // upstream or single-flight. By construction this branch performs no
    // I/O and no awaits, so foreground latency is bounded by the JSON
    // serialize. Operators can grep `cacheDetail=hot-hit` to confirm
    // popular pairs are landing here.
    res.setHeader("X-Cache-Detail", "hot-hit");
    res.json(cached.payload);
    return;
  }

  // Stale-while-revalidate: when we have a cached entry that is past its
  // fresh window but still within last-good range, serve it immediately
  // and kick off a background refresh. This guarantees sub-millisecond
  // response time during upstream incidents — the 30s react-query refetch
  // on the next tick will pick up the refreshed payload.
  const haveStale =
    !!cached && now - cached.cachedAt < CANDLE_LASTGOOD_TTL_MS;

  // Single-flight: coalesce concurrent requests for the same key. We
  // must distinguish two sub-cases for instrumentation:
  //   (a) THIS caller started the compute  → "cold-miss"  (the only
  //       caller actually doing work; subsequent joiners ride along)
  //   (b) THIS caller joined an in-flight  → "joined-inflight"
  // Because `haveStale` short-circuits before the awaited compute, this
  // distinction only matters when there is no usable cached payload at
  // all — i.e., it tells us whether a foreground request had to pay the
  // upstream's full latency or just waited on someone else's compute.
  const wasInflight = candleInflight.has(cacheKey);
  let promise = candleInflight.get(cacheKey);
  if (!promise) {
    promise = (async (): Promise<CandleComputeOutcome> => {
      const barMs = BAR_MS[bar] ?? BAR_MS["4H"];
      const lookbackMs = barMs * Math.max(1, lim);
      const hlInterval = HL_INTERVAL_MAP[bar] ?? bar;
      const coin = sym.replace(/USDT?$/, "");

      let candles: CandleRow[] = [];
      let source: "hyperliquid" | "toobit" | "okx" = "hyperliquid";
      // Track whether ANY tier threw / timed out. The honest-empty
      // outcome (→ 404 with cache) only fires when every tier we tried
      // returned successfully with zero bars; if even one tier errored,
      // we treat the empty result as TRANSIENT (→ 503, no cache) to
      // avoid locking out a working symbol during an upstream incident.
      let hadError = false;

      // Tier 1+2: Hyperliquid → Toobit via candleSource. Bounded so a slow
      // upstream cannot block the event loop on this request.
      try {
        const sourced = await withCandlesTimeout(
          fetchCandlesSourced(coin, hlInterval, lookbackMs),
          3500,
          "candle_source",
        );
        if (sourced.candles.length > 0) {
          candles = sourced.candles.slice(-lim).map((c) => ({
            timestamp: c.t,
            open: parseFloat(c.o),
            high: parseFloat(c.h),
            low: parseFloat(c.l),
            close: parseFloat(c.c),
            volume: parseFloat(c.v),
          }));
          source = sourced.source;
        }
      } catch {
        hadError = true;
        /* fall through to OKX */
      }

      if (candles.length === 0) {
        try {
          const okxCandles = await withCandlesTimeout(
            okx.fetchCandles(sym, lim, bar),
            2500,
            "okx",
          );
          if (okxCandles && okxCandles.length > 0) {
            candles = okxCandles.map((c) => ({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }));
            source = "okx";
          }
        } catch {
          hadError = true;
          /* honest-empty handled below */
        }
      }

      if (candles.length === 0) {
        // Discriminate so the route can choose 404 (registry-listed but
        // every honest upstream returned zero bars — symbol effectively
        // unsupported NOW) vs 503 (at least one upstream errored —
        // transient, do not cache a 404 for a working symbol).
        return { kind: hadError ? "errored" : "honest-empty" };
      }

      const entry: CandleCacheEntry = {
        payload: { symbol: sym, interval: bar, candles, source },
        freshUntil: Date.now() + CANDLE_CACHE_TTL_MS,
        cachedAt: Date.now(),
      };
      // Refresh insertion order on hit so popular symbols stay warm under
      // FIFO eviction.
      candleCache.delete(cacheKey);
      evictCandleCacheIfFull();
      candleCache.set(cacheKey, entry);
      return { kind: "ok", entry };
    })().finally(() => {
      candleInflight.delete(cacheKey);
    });
    candleInflight.set(cacheKey, promise);
  }

  // Stale-while-revalidate: if we have prior data, return it now and let
  // the in-flight refresh run in the background. Swallow its rejection so
  // it cannot trigger an unhandled-rejection on the process.
  //
  // CRITICAL: this branch executes BEFORE any `await promise`, so a
  // foreground caller with usable cached data NEVER waits on the
  // single-flight compute. The promise we hold a handle to is allowed
  // to settle on its own; whatever it produces will be picked up by
  // subsequent requests via the hot-hit path.
  if (haveStale && cached) {
    promise.catch(() => {});
    // Stale served from in-process last-good window. Tell intermediaries
    // not to cache (the next foreground request must reach us so it can
    // pick up the background refresh result), but allow short SWR so a
    // burst of concurrent clients doesn't dogpile.
    res.setHeader("Cache-Control", "public, max-age=0, stale-while-revalidate=10");
    res.setHeader("X-Cache", "STALE");
    res.setHeader("X-Cache-Detail", "stale-served-refreshing");
    res.json({ ...cached.payload, stale: true });
    return;
  }

  // Below this line: we have NO usable cached payload. Either we just
  // started the compute (`!wasInflight` → cold-miss) or we joined an
  // existing one (`wasInflight` → joined-inflight). Both await; the
  // distinction is for instrumentation only.
  const detail = wasInflight ? "joined-inflight" : "cold-miss";

  // CRITICAL — chart-load reliability fix (April 2026):
  //
  // Hard outer cap on the foreground wait. The inner tier timeouts
  // (3500ms HL/Toobit + 2500ms OKX = ~6s envelope) bound the *primary*
  // compute, but a joiner that lands on an in-flight promise belonging
  // to a different fallback path, or one that piles up behind upstream
  // concurrency-slot exhaustion, was previously unbounded. Symptom in
  // production: chart hangs of up to ~2 minutes when many cold symbols
  // got hit at once. We now race the awaited compute against a strict
  // 6.5s wall-clock cap (a hair above the inner envelope so a cleanly-
  // running primary compute always wins). On timeout we DO NOT cancel
  // the underlying promise — it keeps running in the background and the
  // populated cache will satisfy the next request from the hot-hit
  // path. The current request returns a fast 503 (or, defensively,
  // last-good-but-expired data if we have it).
  const FOREGROUND_HARD_CAP_MS = 6500;
  const foregroundDeadline = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), FOREGROUND_HARD_CAP_MS);
  });
  let entry: CandleCacheEntry | null = null;
  // `outcome` carries the discriminated tail-state from the single-flight
  // compute. We track it explicitly (instead of conflating with `entry`)
  // so the 404 vs 503 branch below can tell honest-empty apart from any
  // upstream error case. `null` here means "we never received a non-
  // timeout outcome" — used by the timed-out and thrown branches.
  let outcome: CandleComputeOutcome | null = null;
  let timedOut = false;
  try {
    const raced = await Promise.race([promise, foregroundDeadline]);
    if (raced === "timeout") {
      timedOut = true;
      promise.catch(() => {}); // background continues
    } else {
      outcome = raced;
      if (outcome.kind === "ok") entry = outcome.entry;
    }
  } catch {
    // Unexpected: the inner promise is supposed to never throw (it
    // converts upstream errors into `kind: "errored"` outcomes). If it
    // ever does, treat as transient — same as `errored` below.
    outcome = { kind: "errored" };
  }

  const waitedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

  if (entry) {
    // Fresh compute. Match HIT semantics: clients can cache for the full
    // freshness window and then reuse stale-while-revalidate.
    const maxAgeS = Math.max(0, Math.floor(CANDLE_CACHE_TTL_MS / 1000));
    const swrS = Math.max(0, Math.floor(CANDLE_LASTGOOD_TTL_MS / 1000));
    res.setHeader("Cache-Control", `public, max-age=${maxAgeS}, stale-while-revalidate=${swrS}`);
    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Cache-Detail", detail);
    res.setHeader("X-Candles-Source", entry.payload.source ?? "unknown");
    // Slow-path instrumentation: anything ≥ 1s is candle-flow drag the
    // user can feel. Log every dimension of the slow path so the next
    // engineer can pinpoint blame in a single grep.
    if (waitedMs >= 1000) {
      logger.warn(
        {
          symbol: sym,
          interval: bar,
          limit: lim,
          cacheDetail: detail,
          waitedMs,
          source: entry.payload.source,
          wasInflight,
          hadStaleCache: !!cached,
          blockedBy: "candles", // chart shell is now overlay-independent
        },
        "candles slow foreground wait",
      );
    }
    res.json(entry.payload);
    return;
  }

  // Defensive last-resort: even outside the LASTGOOD window, an old
  // cached payload is strictly better than a blank chart. The frontend
  // also keeps an in-memory candleStore so it can render off its own
  // history, but for any new client we still emit something usable.
  //
  // Cold-miss recovery (April 2026): the original code only inspected
  // the `cached` snapshot taken at line 918, BEFORE the awaited compute.
  // For a brand-new (sym|bar|lim) tuple under upstream throttle that
  // snapshot is null — and the route returned 503 even when adjacent
  // keys (smaller `lim` for the same sym/bar, or a sibling compute
  // that completed during our wait) had already populated the cache.
  // Re-running `candleCacheLookup` here picks up any usable entry that
  // landed during the foreground wait, including the helper's built-in
  // "largest available entry" last-resort branch. Engine math, scoring,
  // and registry math/decay are untouched — this is purely a cache-
  // re-read on the failure path.
  const lastGood = cached ?? candleCacheLookup(sym, bar, lim);
  if (lastGood) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Cache", "STALE-EXPIRED");
    res.setHeader("X-Cache-Detail", timedOut ? "hard-cap-fallback" : "compute-failed-fallback");
    logger.warn(
      {
        symbol: sym,
        interval: bar,
        limit: lim,
        cacheDetail: detail,
        waitedMs,
        timedOut,
        hadStaleCache: true,
        recoveredFromAdjacentKey: cached === null,
        blockedBy: "candles",
      },
      "candles foreground served expired cache",
    );
    res.json({ ...lastGood.payload, stale: true, expired: true });
    return;
  }

  // Truly nothing to serve. The status code depends on WHY:
  //
  //   * `outcome.kind === "honest-empty"` → every upstream tier ran to
  //     completion and returned zero bars without throwing. The
  //     symbol is effectively unsupported NOW (registry says it once
  //     existed but no live venue carries it anymore — typical for
  //     delisted pairs). Emit 404 with a 5-minute Cache-Control so
  //     react-query / browser cache don't retry-storm. This mirrors
  //     the fast-path 404 emitted earlier when the registry is
  //     CERTAIN the symbol is unsupported.
  //
  //   * `outcome.kind === "errored"` OR `timedOut === true` →
  //     transient upstream incident (any tier threw, or the 6.5s hard
  //     cap fired before the compute settled). 503 + no cache, so the
  //     next foreground request can re-attempt as soon as upstreams
  //     recover. CRITICAL: we must NOT emit the cached 404 here, or
  //     a working symbol could get locked out for 5 minutes during
  //     an HL incident.
  //
  // No engine math touched — this is purely status-code correctness.
  if (!timedOut && outcome?.kind === "honest-empty") {
    res.setHeader("Cache-Control", "public, max-age=300");
    logger.warn(
      {
        symbol: sym,
        interval: bar,
        limit: lim,
        cacheDetail: detail,
        waitedMs,
        outcome: "honest-empty",
      },
      "candles foreground returned 404 (registry-listed but live-empty)",
    );
    res.status(404).json({
      error: "unsupported symbol",
      detail: "All candle upstreams returned empty for this symbol",
      symbol: sym,
      interval: bar,
    });
    return;
  }

  // Transient: timeout, error, or unknown failure. Keep the 503 so the
  // next foreground request can re-attempt without a cache barrier.
  logger.warn(
    {
      symbol: sym,
      interval: bar,
      limit: lim,
      cacheDetail: detail,
      waitedMs,
      timedOut,
      outcomeKind: outcome?.kind ?? "no-outcome",
      blockedBy: "candles",
    },
    "candles foreground returned 503",
  );
  res.status(503).json({ error: "no live candles", symbol: sym, interval: bar });
});

// Statistical structural-levels overlay — full canonical engine. The
// orchestrator owns its own TtlCache (with background refresh) and emits
// ETag/Cache-Control headers via sendCached. The route is now a thin
// pass-through; pre-warming for popular pairs happens at server boot.
// Persistent liquidity-level registry — Postgres-backed, hydrated at boot.
// This is the cold-start path that survives an API-server restart: the
// chart fetches it once on mount, then keeps in sync via the
// `levels:<SYMBOL>` WS channel.
router.get("/liquidity/registry-levels", async (req, res): Promise<void> => {
  const { levelRegistry } = await import("../../services/levelRegistry");
  const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol : "BTCUSDT";
  const sym = normalizeSymbol(symbolRaw);
  live.touchSymbol(sym);
  res.json({
    symbol: sym,
    levels: levelRegistry.getLevels(sym),
    updatedAt: new Date().toISOString(),
  });
});

// NOTE: the legacy `/liquidity/structural-levels` route was removed when the
// canonical horizontal-levels engine was dropped in. Its replacement is
// `/api/levels?symbol=...&interval=...` (mounted from src/routes/levels.ts).

// Inbound bar (zod-validated) → HL/Toobit native interval. Only sub-day
// bars get lower-cased; D/W/M stay upper-case so monthly stays monthly.
const HL_INTERVAL_MAP: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1H": "1h", "2H": "2h", "4H": "4h", "6H": "6h", "12H": "12h",
  "1D": "1d", "3D": "3d", "1W": "1w", "1M": "1M",
};

const BAR_MS: Record<string, number> = {
  "1m": 60 * 1000,
  "3m": 3 * 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1H": 60 * 60 * 1000,
  "2H": 2 * 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "6H": 6 * 60 * 60 * 1000,
  "12H": 12 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "3D": 3 * 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

router.get("/liquidity/liquidations", async (req, res): Promise<void> => {
  const parsed = GetLiquidationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { symbol, limit = 50 } = parsed.data;
  const lim = Number(limit);
  const targetSymbols = symbol
    ? [normalizeSymbol(symbol)]
    : DEFAULT_LIQUIDATION_SYMBOLS;

  // Touch each symbol so the per-symbol WS subs (book/ticker) stay warm even
  // if the user only watches the rekt feed. The OKX liquidation-orders
  // channel is instType-wide and doesn't need per-symbol subscription.
  for (const s of targetSymbols) live.touchSymbol(s);

  // Merge OKX + Hyperliquid + Bybit + Binance feeds. Every client stores
  // events with a numeric `ts` so we can interleave by timestamp
  // newest-first deterministically.
  const okxRaw = symbol
    ? getOkxLiquidations(targetSymbols[0]!, lim)
    : getRecentLiquidationsAcross(targetSymbols, lim);
  const hlRaw = symbol
    ? getHlLiquidations(targetSymbols[0]!, lim)
    : getRecentHlLiquidationsAcross(targetSymbols, lim);
  const bybitRaw = symbol
    ? getBybitLiquidations(targetSymbols[0]!, lim)
    : getRecentBybitLiquidationsAcross(targetSymbols, lim);
  const binanceRaw = symbol
    ? getBinanceLiquidations(targetSymbols[0]!, lim)
    : getRecentBinanceLiquidationsAcross(targetSymbols, lim);
  const merged = [...okxRaw, ...hlRaw, ...bybitRaw, ...binanceRaw]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, lim);
  const liquidations = merged.map(stripInternalFields);

  // Honest empty array when no real events have arrived in the cached
  // window. Synthetic demo events were removed in Task #103 — production
  // has always returned [] here when the feed is quiet, and the chart
  // tolerates an empty array gracefully.
  res.json(liquidations);
});

// Server-side aggregation. Groups recent liquidation events into price
// buckets per symbol over a sliding window so the frontend (and any other
// consumer — scanner, alerts, future strategy modules) doesn't have to
// reimplement bucket math. Long/short totals are tracked separately so the
// caller can render imbalance.
router.get("/liquidity/liquidations/clusters", async (req, res): Promise<void> => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
  // Window cap is 7 days, matching the persistence retention. ≤30 min is
  // served from the in-memory ring (strictly fresher); larger windows pull
  // from the persisted log via getClustersFromDb.
  const windowMs = clampInt(
    req.query.windowMs,
    60_000,
    7 * 24 * 60 * 60_000,
    5 * 60_000,
  );
  const bucketBps = clampInt(req.query.bucketBps, 1, 200, 20); // 0.01% .. 2%
  const maxClusters = clampInt(req.query.limit, 1, 200, 50);
  const minUsd = clampInt(req.query.minUsd, 0, 1_000_000_000, 0);

  const targetSymbols = symbol
    ? [normalizeSymbol(symbol)]
    : DEFAULT_LIQUIDATION_SYMBOLS;
  for (const s of targetSymbols) live.touchSymbol(s);

  const IN_MEMORY_MAX_MS = 30 * 60_000;
  if (windowMs > IN_MEMORY_MAX_MS) {
    try {
      const dbClusters = await getClustersFromDb({
        symbols: targetSymbols,
        windowMs,
        bucketBps,
        minUsd,
        maxClusters,
      });
      const clusters = dbClusters.map((c) => ({
        symbol: c.symbol,
        bucketPrice: round(c.bucketPrice, 8),
        bucketLow: round(c.bucketLow, 8),
        bucketHigh: round(c.bucketHigh, 8),
        longUsd: round(c.longUsd, 2),
        shortUsd: round(c.shortUsd, 2),
        totalUsd: round(c.totalUsd, 2),
        count: c.count,
        sources: {
          okx: c.okxCount,
          hyperliquid: c.hlCount,
          bybit: c.bybitCount,
          binance: c.binanceCount,
        },
        lastTimestamp: new Date(c.lastTs).toISOString(),
      }));
      res.json({
        windowMs,
        bucketBps,
        symbols: targetSymbols,
        clusters,
        source: "db",
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      // Surface, then fall through to the in-memory path so the chart
      // still renders something rather than going blank if Postgres is
      // momentarily unavailable.
      request.log.warn(
        { err: String(err) },
        "clusters: db aggregation failed, falling back to in-memory",
      );
    }
  }

  const cutoff = Date.now() - windowMs;

  // Pull both feeds, filter by window, aggregate per (symbol, priceBucket).
  type Cluster = {
    symbol: string;
    bucketPrice: number;
    bucketLow: number;
    bucketHigh: number;
    longUsd: number;
    shortUsd: number;
    totalUsd: number;
    count: number;
    sources: { okx: number; hyperliquid: number; bybit: number; binance: number };
    lastTs: number;
  };
  const out = new Map<string, Cluster>();

  function bucketize(ev: {
    symbol: string;
    side: "long" | "short";
    price: number;
    usdValue: number;
    ts: number;
    exchange: "okx" | "hyperliquid" | "bybit" | "binance";
  }) {
    if (ev.ts < cutoff) return;
    if (!Number.isFinite(ev.price) || ev.price <= 0) return;
    const widthFrac = bucketBps / 10_000;
    // log-space bucketing keeps relative width stable across price scales.
    const idx = Math.floor(Math.log(ev.price) / Math.log(1 + widthFrac));
    const bucketLow = Math.pow(1 + widthFrac, idx);
    const bucketHigh = Math.pow(1 + widthFrac, idx + 1);
    const bucketPrice = (bucketLow + bucketHigh) / 2;
    const key = `${ev.symbol}@${idx}`;
    let c = out.get(key);
    if (!c) {
      c = {
        symbol: ev.symbol,
        bucketPrice,
        bucketLow,
        bucketHigh,
        longUsd: 0,
        shortUsd: 0,
        totalUsd: 0,
        count: 0,
        sources: { okx: 0, hyperliquid: 0, bybit: 0, binance: 0 },
        lastTs: 0,
      };
      out.set(key, c);
    }
    if (ev.side === "long") c.longUsd += ev.usdValue;
    else c.shortUsd += ev.usdValue;
    c.totalUsd += ev.usdValue;
    c.count += 1;
    c.sources[ev.exchange] += 1;
    if (ev.ts > c.lastTs) c.lastTs = ev.ts;
  }

  for (const s of targetSymbols) {
    for (const e of getOkxLiquidations(s, MAX_AGG_PER_SYMBOL)) bucketize(e);
    for (const e of getHlLiquidations(s, MAX_AGG_PER_SYMBOL)) bucketize(e);
    for (const e of getBybitLiquidations(s, MAX_AGG_PER_SYMBOL)) bucketize(e);
    for (const e of getBinanceLiquidations(s, MAX_AGG_PER_SYMBOL)) bucketize(e);
  }

  const clusters = Array.from(out.values())
    .filter((c) => c.totalUsd >= minUsd)
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, maxClusters)
    .map((c) => ({
      ...c,
      bucketPrice: round(c.bucketPrice, 8),
      bucketLow: round(c.bucketLow, 8),
      bucketHigh: round(c.bucketHigh, 8),
      longUsd: round(c.longUsd, 2),
      shortUsd: round(c.shortUsd, 2),
      totalUsd: round(c.totalUsd, 2),
      lastTimestamp: new Date(c.lastTs).toISOString(),
    }));

  res.json({
    windowMs,
    bucketBps,
    symbols: targetSymbols,
    clusters,
    source: "memory",
    updatedAt: new Date().toISOString(),
  });
});

// Aggregated overlays for the heatmap chart: funding-rate divergence,
// per-bucket OI delta, taker buy/sell pressure, and rolling CVD. All five
// series are derived from the WS-fed stores by analytics-store's sampler so
// no extra REST traffic is incurred per request. Magnet zones reuse the
// existing /liquidity/liquidations/clusters endpoint client-side.
router.get("/liquidity/analytics/:symbol", (req, res): void => {
  const symbol = normalizeSymbol(String(req.params.symbol || ""));
  if (!symbol) { res.status(400).json({ error: "symbol required" }); return; }
  const windowMs = clampInt(req.query.windowMs, 60_000, 60 * 60_000, 30 * 60_000);
  // Touch so the WS subscriptions stay warm if the user is only watching the
  // analytics overlays on a backwater symbol.
  live.touchSymbol(symbol);
  res.json(getAnalytics(symbol, windowMs));
});

router.get("/liquidity/analytics-stats", (_req, res): void => {
  res.json(analyticsStoreStats());
});

const MAX_AGG_PER_SYMBOL = 500;

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function stripInternalFields(e: {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  timestamp: string;
}): {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  timestamp: string;
} {
  return {
    id: e.id,
    symbol: e.symbol,
    side: e.side,
    price: e.price,
    size: e.size,
    usdValue: e.usdValue,
    timestamp: e.timestamp,
  };
}

// Boot-time WS pin set: the always-warm core. Browser-touched symbols are
// added on demand via the touch() mechanism in live.ts and evicted after
// their TTL — they don't need to be pinned here. The scanner now iterates
// the full unioned universe (see runScanner) regardless of this list.
const SCANNER_BOOT_PINS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "SUIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
  "INJUSDT", "TIAUSDT", "WIFUSDT", "PEPEUSDT", "TONUSDT",
  "TRXUSDT", "TAOUSDT", "TRUMPUSDT", "POLUSDT", "PENDLEUSDT",
];

// Per-cycle symbol cap for the scanner. Configurable so operators can dial
// it back if the host is under load. 0 / unset = "all" (the user explicitly
// asked for the full unioned universe).
const SCANNER_MAX_SYMBOLS = (() => {
  const raw = process.env.SCANNER_MAX_SYMBOLS;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

const PROXIMITY_THRESHOLD = 0.003;
const MIN_COMPOSITE_SCORE = 0.55;

interface ScannerAlert {
  id: string;
  symbol: string;
  markPrice: number;
  levelPrice: number;
  strength: number;
  tier: "elite" | "strong" | "normal";
  side: "approaching_support" | "approaching_resistance";
  distancePct: number;
  timestamp: string;
  exchange: string;
}

const scannerCache: {
  data: ScannerAlert[];
  updatedAt: number;
  scannedCount: number;
} = {
  data: [],
  updatedAt: 0,
  scannedCount: 0,
};
// TTL is bigger than the original 4s because each cycle now sweeps the full
// unioned universe (hundreds of symbols) instead of a hardcoded 25.
const SCANNER_CACHE_TTL = 15_000;
const SCANNER_BATCH_SIZE = 25;

async function runScanner(): Promise<ScannerAlert[]> {
  const now = Date.now();
  if (now - scannerCache.updatedAt < SCANNER_CACHE_TTL) {
    return scannerCache.data;
  }

  // Build the cycle's symbol list from the unioned universe. Sorted by 24h
  // volume desc, so if SCANNER_MAX_SYMBOLS clips the tail we keep the most
  // liquid markets where levels matter most.
  let universeSymbols: string[];
  try {
    const snap = await getUnionUniverse();
    universeSymbols = snap.entries.map((e) => e.symbol);
  } catch {
    universeSymbols = SCANNER_BOOT_PINS.slice();
  }
  if (universeSymbols.length === 0) {
    universeSymbols = SCANNER_BOOT_PINS.slice();
  }
  if (SCANNER_MAX_SYMBOLS > 0 && universeSymbols.length > SCANNER_MAX_SYMBOLS) {
    universeSymbols = universeSymbols.slice(0, SCANNER_MAX_SYMBOLS);
  }

  const alerts: ScannerAlert[] = [];

  const batchSize = SCANNER_BATCH_SIZE;
  for (let b = 0; b < universeSymbols.length; b += batchSize) {
    const batch = universeSymbols.slice(b, b + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (sym) => {
        const [realBook, realTicker] = await Promise.all([
          getRealOrderbook(sym, 200),
          getRealTicker(sym),
        ]);

        // Skip symbols without both a real ticker AND a real book — the
        // scanner refuses to flag levels derived from any synthetic depth.
        if (!realTicker || !realBook || realBook.bids.length === 0 || realBook.asks.length === 0) {
          return [];
        }

        const bids = realBook.bids;
        const asks = realBook.asks;
        const exchange = realBook.source;

        const levels = buildHeatLevels(bids, asks, realTicker.markPrice, 80);
        const markPrice = realTicker.markPrice;
        const symbolAlerts: ScannerAlert[] = [];

        for (const level of levels) {
          if (level.compositeScore < MIN_COMPOSITE_SCORE) continue;

          const dist = (level.price - markPrice) / markPrice;
          const absDist = Math.abs(dist);

          if (absDist > PROXIMITY_THRESHOLD) continue;

          const tier = level.compositeScore >= 0.85 ? "elite" :
                       level.compositeScore >= 0.65 ? "strong" : "normal";

          const side = dist > 0 ? "approaching_resistance" : "approaching_support";

          symbolAlerts.push({
            id: `${sym}-${level.price.toFixed(6)}-${now}`,
            symbol: sym,
            markPrice,
            levelPrice: level.price,
            strength: parseFloat(level.compositeScore.toFixed(4)),
            tier,
            side,
            distancePct: parseFloat((absDist * 100).toFixed(4)),
            timestamp: new Date().toISOString(),
            exchange,
          });
        }

        return symbolAlerts;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        alerts.push(...r.value);
      }
    }
  }

  alerts.sort((a, b) => {
    const tierOrder = { elite: 0, strong: 1, normal: 2 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.distancePct - b.distancePct;
  });

  scannerCache.data = alerts;
  scannerCache.updatedAt = now;
  scannerCache.scannedCount = universeSymbols.length;

  return alerts;
}

router.get("/liquidity/scanner", async (_req, res): Promise<void> => {
  const alerts = await runScanner();

  res.json({
    alerts,
    scannedSymbols: scannerCache.scannedCount,
    updatedAt: new Date().toISOString(),
  });
});

router.get("/liquidity/ws-health", (_req, res): void => {
  res.json(live.getLiveHealth());
});

// --- Level-touch scanner ---
//
// Finds tickers whose live price is currently touching (or hugging) a
// structural level produced by the structural-levels engine. The user
// chooses which level sources count (KDE, market profile, quantile bands,
// swing pivots, liquidations) and how loose the touch tolerance is.
//
// Strategy:
//   - universe: warm WS-active set (`listActive`), capped per request
//   - per-symbol: read cached structural-levels (no compute blocking)
//   - per-symbol price: read live ticker stores directly (no auto-sub)
//   - per-symbol timeout to keep the request snappy on cold caches
//   - liquidation densities are scanned from the engine's `liquidations`
//     array (they're not part of `zones`)

type LevelSourceId =
  | "kde"
  | "market_profile"
  | "quantile"
  | "pivots"
  | "liquidations";

const SOURCE_TO_METHODS: Record<Exclude<LevelSourceId, "liquidations">, string[]> = {
  kde: ["kde-pivot-cluster"],
  market_profile: ["market-profile-poc", "value-area-high", "value-area-low"],
  quantile: ["quantile-band"],
  pivots: ["swing-pivot"],
};
const ALL_SOURCES: LevelSourceId[] = [
  "kde",
  "market_profile",
  "quantile",
  "pivots",
  "liquidations",
];

interface LevelTouchRow {
  symbol: string;
  lastPrice: number;
  side: "above" | "below" | "inside";
  distancePct: number;
  touchScore: number;
  timeframe: string;
  // "structural" → from cached structural-zone engine output
  // "liquidity"  → from cached liquidation-density engine output
  // "both"       → synthetic combo row produced in `mode=buckets`
  //                when one symbol is simultaneously touching at least
  //                one structural zone AND one liquidation level. The
  //                row's `level` carries the structural side; the
  //                companion liquidity reference lives on `companion`.
  comboType?: "structural" | "liquidity" | "both";
  companion?: {
    priceLow: number;
    priceHigh: number;
    midPrice: number;
    kind: "support" | "resistance" | "neutral";
    confidence: "high" | "medium" | "low";
    score: number;
    methods: string[];
    source: LevelSourceId;
    leverage?: number;
  };
  level: {
    priceLow: number;
    priceHigh: number;
    midPrice: number;
    kind: "support" | "resistance" | "neutral";
    confidence: "high" | "medium" | "low";
    score: number;
    methods: string[];
    source: LevelSourceId;
    leverage?: number;
  };
}

function liveLastPrice(symbol: string): number | null {
  const tk = okxStore.getTicker(symbol);
  if (tk) {
    const p = parseFloat(tk.last);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const hl = hlStore.getAsset(symbol);
  if (hl && Number.isFinite(hl.markPx) && hl.markPx > 0) return hl.markPx;
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const CONFIDENCE_WEIGHT = { high: 1, medium: 0.7, low: 0.45 } as const;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

// ----- Level-touch scanner: per-request caps and background warmer -----
//
// The level-touch scanner used to be capped at 80 symbols per request and
// only warmed symbols a user explicitly opened. Two changes here:
//
//   1) Bigger universe per request. UNIVERSE_HARD_CAP is now 300 (env-
//      overridable via LEVEL_TOUCH_UNIVERSE_CAP), and the result limit
//      ceiling is bumped to match. Concurrency is doubled because most
//      structural-level lookups now hit the warm SWR cache.
//
//   2) Persistent background warmer. A long-running interval cycles
//      through the full unioned universe, calling `live.touchSymbol`
//      (keeps WS subscriptions alive) and `getCachedLevelsAndRecord`
//      (keeps the SWR cache primed). The result is that when a user
//      opens the scanner, the entire larger universe is already hot:
//      no "warming"/"coldLevels" placeholders for tickers the warmer has
//      seen at least once. The warmer processes a small batch each tick
//      so it never spikes CPU; a full cycle through ~700 symbols at the
//      defaults below takes roughly 3-4 minutes.
const LEVEL_TOUCH_UNIVERSE_CAP = (() => {
  const n = Number(process.env.LEVEL_TOUCH_UNIVERSE_CAP);
  return Number.isFinite(n) && n >= 50 ? Math.min(800, Math.floor(n)) : 300;
})();
const LEVEL_TOUCH_RESULT_CAP = Math.max(100, LEVEL_TOUCH_UNIVERSE_CAP);
const LEVEL_TOUCH_CONCURRENCY = (() => {
  const n = Number(process.env.LEVEL_TOUCH_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 4;
})();
const LEVEL_TOUCH_WARM_INTERVALS: ReadonlyArray<string> = (() => {
  const raw = process.env.LEVEL_TOUCH_WARM_INTERVALS;
  // Default warms BOTH "4H" (used by the existing level-touch UI) and
  // "1m" (used by the new 1m multi-touch mode). The warmer batch size
  // and tick interval are unchanged — adding a second interval just
  // doubles per-symbol cache fills, which still completes a full
  // universe sweep in single-digit minutes.
  if (!raw) return ["4H", "1m"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
})();
// Smaller per-tick batch and a slower tick so the background warmer is
// always a small minority of the total HL request volume. With these
// defaults a full pass through ~700 symbols takes ~12 minutes — plenty
// fresh for 4H structural levels, and well below the threshold where
// the warmer crowds out foreground requests.
const LEVEL_TOUCH_WARM_BATCH = (() => {
  const n = Number(process.env.LEVEL_TOUCH_WARM_BATCH);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 6;
})();
const LEVEL_TOUCH_WARM_INTERVAL_MS = (() => {
  const n = Number(process.env.LEVEL_TOUCH_WARM_INTERVAL_MS);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 6_000;
})();

let warmerStarted = false;
function startLevelTouchWarmer(): void {
  if (warmerStarted) return;
  warmerStarted = true;
  let cycleSymbols: string[] = [];
  let cursor = 0;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      if (cursor >= cycleSymbols.length) {
        // Refresh the cycle list at the start of each pass so newly listed
        // pairs (or operator-driven universe edits) get picked up.
        try {
          const snap = await getUnionUniverse();
          cycleSymbols = snap.entries
            .map((e) => e.symbol)
            .slice(0, LEVEL_TOUCH_UNIVERSE_CAP);
        } catch {
          cycleSymbols = [];
        }
        cursor = 0;
        if (cycleSymbols.length === 0) return;
      }

      const batch = cycleSymbols.slice(cursor, cursor + LEVEL_TOUCH_WARM_BATCH);
      cursor += batch.length;

      const tb = getToobitWs();
      await Promise.allSettled(
        batch.map(async (sym) => {
          // Keep the WS subs alive so liveLastPrice() stays fresh.
          live.touchSymbol(sym);
          // touchSymbol only covers OKX/HL — also poke Toobit so its
          // ~273 single-listing symbols (e.g. EDUUSDT, SPX500USDT) stay
          // subscribed and serve real prices through getRealTicker.
          if (tb && tb.isToobitSupported(sym)) tb.ensureSubscribed(sym);
          // Touch the SWR structural-levels cache for each warm interval.
          // Fire-and-forget; we don't care about the result, only the
          // side effect of populating the cache.
          for (const interval of LEVEL_TOUCH_WARM_INTERVALS) {
            try {
              await getCachedLevelsAndRecord(sym, interval);
            } catch {
              /* ignore per-symbol errors; next cycle will retry */
            }
          }
        }),
      );
    } finally {
      inFlight = false;
    }
  }

  // Delay the first tick by 30s so the boot fan-out (8 seed warmers each
  // running a recursive HTF + peer fetch) has time to settle before we
  // start cycling through the universe. Without this delay the warmer
  // piled on while the boot wave was still in flight, pushing our IP into
  // HL's 429 zone and surfacing as /api/levels 502s for many symbols.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), LEVEL_TOUCH_WARM_INTERVAL_MS).unref();
  }, 30_000).unref();
}

router.post("/liquidity/level-touch-scan", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    interval?: string;
    tolerancePct?: number | "auto";
    minConfidence?: "any" | "medium" | "high";
    sources?: LevelSourceId[];
    universeMode?: "warm" | "warm_plus_top";
    limit?: number;
    // ----- new fields (back-compatible defaults) -----
    // "best_per_symbol" (default) keeps the legacy flat output (one
    // best-touched row per symbol). "buckets" splits each symbol into
    // best-structural + best-liquidity rows and emits a synthetic
    // "both" row when the symbol is simultaneously touching at least
    // one of each — feeds the new 1m multi-touch UI.
    mode?: "best_per_symbol" | "buckets";
  };

  const interval = typeof body.interval === "string" && body.interval ? body.interval : "4H";
  // tolerancePct: number percent (0.05 — 2.0) OR the string "auto" which
  // sizes tolerance from 1m ATR. ATR-auto is only honored when we can
  // fetch 1m candles (i.e. interval == "1m") — for other intervals we
  // fall back to the static default.
  let tolerancePct: number;
  let toleranceMode: "fixed" | "auto" = "fixed";
  if (body.tolerancePct === "auto") {
    toleranceMode = "auto";
    tolerancePct = 0.25; // initial fallback before per-symbol ATR sizing
  } else {
    const tolNum = Number(body.tolerancePct);
    tolerancePct = Math.max(
      0.05,
      Math.min(2, Number.isFinite(tolNum) ? tolNum : 0.25),
    );
  }
  const mode: "best_per_symbol" | "buckets" =
    body.mode === "buckets" ? "buckets" : "best_per_symbol";
  // Latest-1m-candle wick overlap is only relevant when scanning the
  // 1m timeframe. On higher TFs the "current bar" is too wide to be a
  // useful overlap test.
  const useCandleOverlap = interval === "1m";
  const VALID_CONF: ReadonlyArray<"any" | "medium" | "high"> = ["any", "medium", "high"];
  const minConfidence: "any" | "medium" | "high" =
    body.minConfidence && VALID_CONF.includes(body.minConfidence)
      ? body.minConfidence
      : "any";
  const filteredSources = Array.isArray(body.sources)
    ? body.sources.filter((s): s is LevelSourceId => ALL_SOURCES.includes(s))
    : [];
  const requestedSources: LevelSourceId[] =
    filteredSources.length > 0 ? filteredSources : ALL_SOURCES;
  const universeMode: "warm" | "warm_plus_top" =
    body.universeMode === "warm_plus_top" ? "warm_plus_top" : "warm";
  const limNum = Number(body.limit);
  const limit = Math.max(5, Math.min(LEVEL_TOUCH_RESULT_CAP, Number.isFinite(limNum) ? limNum : 50));

  const enabledMethods = new Set<string>();
  for (const s of requestedSources) {
    if (s === "liquidations") continue;
    for (const m of SOURCE_TO_METHODS[s]) enabledMethods.add(m);
  }
  const liquidationsEnabled = requestedSources.includes("liquidations");

  // Universe: warm WS-active symbols, optionally extended with top-N-by-
  // volume from the unioned universe to give breadth when the warm set
  // is small. Total is capped to keep the structural engine happy.
  //
  // In `warm_plus_top` mode we also opportunistically `touchSymbol()` each
  // newly-included symbol so its OKX/HL WS subscriptions start warming in
  // the background. The first scan will likely skip most of those (no
  // ticker / no cached structural levels yet); successive scans pick them
  // up as data arrives. The footer surfaces the warming count so users
  // can tell partial results from "no matches".
  const warmSet = new Set(listActive());
  const universeArr: string[] = Array.from(warmSet);
  const newlyWarmedCount = { value: 0 };
  if (universeMode === "warm_plus_top" && universeArr.length < LEVEL_TOUCH_UNIVERSE_CAP) {
    try {
      const snap = await getUnionUniverse();
      for (const e of snap.entries) {
        if (universeArr.length >= LEVEL_TOUCH_UNIVERSE_CAP) break;
        if (warmSet.has(e.symbol)) continue;
        universeArr.push(e.symbol);
        // Kick off WS subscription so subsequent scans see this symbol's
        // ticker/book. Fire-and-forget; first scan still treats this
        // symbol as "warming" until the data lands — but the background
        // warmer (startLevelTouchWarmer below) will already have most of
        // the unioned universe primed.
        live.touchSymbol(e.symbol);
        newlyWarmedCount.value++;
      }
    } catch {
      /* fall back to warm-only on any universe fetch failure */
    }
  }
  const universe = universeArr.slice(0, LEVEL_TOUCH_UNIVERSE_CAP);

  const defaultTolFrac = tolerancePct / 100;
  const minConfRank = minConfidence === "any" ? 0 : CONFIDENCE_RANK[minConfidence];

  let scanned = 0;
  let warming = 0;        // symbol has no live ticker yet (WS still warming)
  let coldLevels = 0;     // ticker present, but structural-levels cache is cold
  const errors: { symbol: string; error: string }[] = [];
  const rows: LevelTouchRow[] = [];
  // Comparison-layer counters (no engine impact) — surfaced on the
  // response so the UI can show "N candle-overlap touches" at a glance.
  let candleOverlapHits = 0;
  let bothBucketCount = 0;

  // Bounded concurrency. Higher than the original 4 because the background
  // warmer keeps most symbols' structural-levels in the SWR cache, so each
  // worker tick is a cheap cache hit rather than a full KDE/MP recompute.
  const CONCURRENCY = LEVEL_TOUCH_CONCURRENCY;
  const PER_SYMBOL_TIMEOUT_MS = 5_000;
  // 1m-only: short candle window powers (a) ATR-auto tolerance sizing
  // and (b) latest-candle wick-overlap detection. Lookback is ~30 bars
  // (~30 minutes) which is plenty for ATR(14) and is cheap because
  // candleSource has its own SWR cache.
  const CANDLE_LOOKBACK_MS = 30 * 60 * 1000;
  const CANDLE_TIMEOUT_MS = 2_500;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < universe.length) {
      const symbol = universe[cursor++]!;
      scanned++;
      const price = liveLastPrice(symbol);
      if (price === null) {
        warming++;
        continue;
      }
      // Fetch cached structural+liquidity levels. Same call the legacy
      // path uses — guarantees we are NOT recomputing the engine.
      const cached = await withTimeout(
        getCachedLevelsAndRecord(symbol, interval).then((r) => r.value),
        PER_SYMBOL_TIMEOUT_MS,
      );
      if (!cached) {
        coldLevels++;
        continue;
      }

      // ----- 1m enrichment: latest candle high/low + ATR(14) -----
      // Comparison-layer only: stats over already-fetched candles.
      // Engine math (scoring, registry, regime, etc.) is untouched.
      let latestHigh: number | null = null;
      let latestLow: number | null = null;
      let symTolFrac = defaultTolFrac;
      let symTolerancePct = tolerancePct;
      if (useCandleOverlap || (toleranceMode === "auto" && interval === "1m")) {
        const sourced = await withTimeout(
          fetchCandlesSourced(symbol, "1m", CANDLE_LOOKBACK_MS),
          CANDLE_TIMEOUT_MS,
        );
        const cs = sourced?.candles ?? [];
        if (cs.length > 0) {
          const last = cs[cs.length - 1]!;
          const h = parseFloat(last.h);
          const l = parseFloat(last.l);
          if (Number.isFinite(h) && Number.isFinite(l)) {
            latestHigh = h;
            latestLow = l;
          }
          if (toleranceMode === "auto" && cs.length >= 2) {
            // ATR(14) — Wilder true-range mean over the last min(14, n-1)
            // bars. Half the ATR-as-fraction-of-price gives a tolerance
            // that lets price wick into a level without demanding a
            // tagged equality.
            const trs: number[] = [];
            for (let i = 1; i < cs.length; i++) {
              const cur = cs[i]!;
              const prev = cs[i - 1]!;
              const ch = parseFloat(cur.h);
              const cl = parseFloat(cur.l);
              const pc = parseFloat(prev.c);
              if (
                !Number.isFinite(ch) ||
                !Number.isFinite(cl) ||
                !Number.isFinite(pc)
              )
                continue;
              const tr = Math.max(
                ch - cl,
                Math.abs(ch - pc),
                Math.abs(cl - pc),
              );
              trs.push(tr);
            }
            const window = trs.slice(-14);
            if (window.length > 0) {
              const atr = window.reduce((a, b) => a + b, 0) / window.length;
              const frac = (atr / price) * 0.5;
              // Clamp: 0.05% lower bound (price-precision floor) /
              // 2% upper bound (no exotic spreads).
              symTolFrac = Math.min(0.02, Math.max(0.0005, frac));
              symTolerancePct = symTolFrac * 100;
            }
          }
        }
      }

      // Wick-overlap helper: returns true if the latest 1m bar's
      // high/low straddle the level band (any portion of [low, high]
      // intersects [priceLow, priceHigh]).
      const wickOverlaps = (
        priceLow: number,
        priceHigh: number,
      ): boolean => {
        if (!useCandleOverlap || latestHigh === null || latestLow === null)
          return false;
        return latestHigh >= priceLow && latestLow <= priceHigh;
      };

      const structuralCandidates: LevelTouchRow[] = [];
      const liquidityCandidates: LevelTouchRow[] = [];

      // Structural zones
      for (const z of cached.zones) {
        if (minConfRank > 0 && CONFIDENCE_RANK[z.confidence] < minConfRank) continue;
        const matchedMethod = z.methods.find((m) => enabledMethods.has(m));
        if (!matchedMethod) continue;
        const lowB = z.priceLow * (1 - symTolFrac);
        const highB = z.priceHigh * (1 + symTolFrac);
        const priceTouch = price >= lowB && price <= highB;
        const wickTouch = wickOverlaps(z.priceLow, z.priceHigh);
        if (!priceTouch && !wickTouch) continue;
        if (wickTouch && !priceTouch) candleOverlapHits++;
        const inside = wickTouch || (price >= z.priceLow && price <= z.priceHigh);
        // Distance from zone mid (per spec). Denominator is the zone mid
        // so the metric describes price's offset from the level itself,
        // independent of where price happens to be. Proximity (used for
        // touch score) still uses edge distance so price inside the zone
        // is treated as a perfect touch.
        const zoneMid = (z.priceLow + z.priceHigh) / 2;
        const distancePct = (Math.abs(price - zoneMid) / zoneMid) * 100;
        const edgeDist = inside
          ? 0
          : price < z.priceLow
            ? z.priceLow - price
            : price - z.priceHigh;
        const edgeDistPct = (edgeDist / price) * 100;
        const proximity = Math.max(0, 1 - edgeDistPct / symTolerancePct);
        const touchScore =
          z.score * CONFIDENCE_WEIGHT[z.confidence] * (0.4 + 0.6 * proximity);
        const sourceId: LevelSourceId =
          matchedMethod === "kde-pivot-cluster"
            ? "kde"
            : matchedMethod.startsWith("market-profile") || matchedMethod.startsWith("value-area")
              ? "market_profile"
              : matchedMethod === "quantile-band"
                ? "quantile"
                : "pivots";
        structuralCandidates.push({
          symbol,
          lastPrice: price,
          side: inside ? "inside" : price < z.priceLow ? "below" : "above",
          distancePct,
          touchScore,
          timeframe: interval,
          comboType: "structural",
          level: {
            priceLow: z.priceLow,
            priceHigh: z.priceHigh,
            midPrice: zoneMid,
            kind: z.kind,
            confidence: z.confidence,
            score: z.score,
            methods: z.methods,
            source: sourceId,
          },
        });
      }

      // Liquidation densities (treated as point levels)
      if (liquidationsEnabled) {
        for (const liq of cached.liquidations) {
          const liqConfidence: "high" | "medium" | "low" =
            liq.density >= 0.6 ? "high" : liq.density >= 0.4 ? "medium" : "low";
          if (minConfRank > 0 && CONFIDENCE_RANK[liqConfidence] < minConfRank) continue;
          const lowB = liq.price * (1 - symTolFrac);
          const highB = liq.price * (1 + symTolFrac);
          const priceTouch = price >= lowB && price <= highB;
          const wickTouch = wickOverlaps(liq.price, liq.price);
          if (!priceTouch && !wickTouch) continue;
          if (wickTouch && !priceTouch) candleOverlapHits++;
          const distancePct = (Math.abs(price - liq.price) / liq.price) * 100;
          const proximity = wickTouch
            ? 1
            : Math.max(0, 1 - distancePct / symTolerancePct);
          const kind: "support" | "resistance" = liq.price < price ? "support" : "resistance";
          // Treat density as a normalized score; weight by leverage tier
          // (lower leverage = thicker liquidation cluster, more impact).
          const levWeight = liq.leverage <= 10 ? 1 : liq.leverage <= 25 ? 0.8 : 0.6;
          const touchScore = liq.density * levWeight * (0.4 + 0.6 * proximity);
          liquidityCandidates.push({
            symbol,
            lastPrice: price,
            side: wickTouch
              ? "inside"
              : price === liq.price
                ? "inside"
                : price < liq.price
                  ? "below"
                  : "above",
            distancePct,
            touchScore,
            timeframe: interval,
            comboType: "liquidity",
            level: {
              priceLow: liq.price,
              priceHigh: liq.price,
              midPrice: liq.price,
              kind,
              confidence: liqConfidence,
              score: liq.density,
              methods: [`liquidation-${liq.leverage}x`],
              source: "liquidations",
              leverage: liq.leverage,
            },
          });
        }
      }

      const allCandidates = [...structuralCandidates, ...liquidityCandidates];
      if (allCandidates.length === 0) continue;

      if (mode === "buckets") {
        // Best structural and best liquidity for this symbol, plus a
        // synthetic "both" combo when the symbol is touching at least
        // one of each. The combo row's touchScore is a boosted blend
        // (sum) so it consistently sorts above pure-structural or
        // pure-liquidity rows of similar individual quality — this is
        // the "structural ∧ liquidity confluence" the user asked to
        // surface first.
        structuralCandidates.sort((a, b) => b.touchScore - a.touchScore);
        liquidityCandidates.sort((a, b) => b.touchScore - a.touchScore);
        const bestStruct = structuralCandidates[0];
        const bestLiq = liquidityCandidates[0];
        if (bestStruct && bestLiq) {
          bothBucketCount++;
          rows.push({
            ...bestStruct,
            comboType: "both",
            // Combined score: sum of both touch scores so combos
            // outrank either-alone matches of similar magnitude.
            touchScore: bestStruct.touchScore + bestLiq.touchScore,
            companion: bestLiq.level,
          });
        }
        if (bestStruct) rows.push(bestStruct);
        if (bestLiq) rows.push(bestLiq);
      } else {
        // Legacy "best per symbol" output: highest single-zone score wins.
        allCandidates.sort((a, b) => b.touchScore - a.touchScore);
        rows.push(allCandidates[0]!);
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, universe.length) }, () => worker()),
    );
  } catch (err) {
    errors.push({ symbol: "*", error: (err as Error).message ?? "scan failed" });
  }

  // Bucket-aware sort: when running in `mode=buckets`, "both" combo
  // rows always come first (the user explicitly asked for these to
  // surface ahead of single-bucket touches). Within each tier the
  // touchScore breaks ties.
  const COMBO_RANK: Record<string, number> = { both: 3, structural: 2, liquidity: 1 };
  rows.sort((a, b) => {
    if (mode === "buckets") {
      const ra = COMBO_RANK[a.comboType ?? ""] ?? 0;
      const rb = COMBO_RANK[b.comboType ?? ""] ?? 0;
      if (ra !== rb) return rb - ra;
    }
    return b.touchScore - a.touchScore;
  });
  const trimmed = rows.slice(0, limit);

  res.json({
    ok: true,
    interval,
    tolerancePct,
    toleranceMode,
    mode,
    minConfidence,
    sources: requestedSources,
    universeMode,
    universeSize: universe.length,
    warmCount: warmSet.size,
    newlyWarmed: newlyWarmedCount.value,
    scanned,
    matched: rows.length,
    warming,
    coldLevels,
    candleOverlapHits,
    bothBucketCount,
    // Kept for backwards compatibility with older clients.
    skipped: warming + coldLevels,
    rows: trimmed,
    errors,
  });
});

// Boot the WS layer with a small "always warm" set permanently pinned so
// scanner alerts on the major markets are ready immediately at boot. The
// scanner itself iterates the full unioned universe (see runScanner);
// non-pinned symbols rely on the existing touch() mechanism in live.ts to
// activate WS subs on demand.
if (process.env["SKIP_LIVE_BOOT"] !== "1") {
  live.startLiveMarketData(SCANNER_BOOT_PINS);
}

// Continuously cycle the unioned universe in the background so the
// level-touch scanner stays warm even when no user is actively running it.
// See the comment block above the LEVEL_TOUCH_* constants for tuning.
startLevelTouchWarmer();

// --- Toobit (Phase B, optional, double-locked) ---
// Mounted only when ENABLE_TOOBIT=1 AND TOOBIT_GEO_HEADER is set. The WS
// connection is also only started in that case, so existing users see zero
// behavior change until the operator explicitly opts in.
if (toobitEnabled()) {
  // Lazy require keeps the WS module dormant when the flag is off.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startToobitWs } = require("./exchanges/toobit-ws") as typeof import("./exchanges/toobit-ws");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const toobitRouter = (require("./toobit") as { default: IRouter }).default;
  if (process.env["SKIP_LIVE_BOOT"] !== "1") startToobitWs();
  router.use(toobitRouter);
}

export default router;
