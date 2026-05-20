import * as okx from "../routes/liquidity/exchanges/okx";
import * as hl from "../routes/liquidity/exchanges/hyperliquid";
import { hlStore } from "../routes/liquidity/exchanges/ws-store";
// Liquidity score is derived from real 24h notional volume tiers — no
// hard-coded per-symbol table. Keeps the overview honest when an asset
// the catalog never knew about (newly listed perp) is the most active.
function deriveLiquidityScore(volume24h: number): number {
  if (volume24h >= 1e9) return 5.0;
  if (volume24h >= 1e8) return 4.0;
  if (volume24h >= 1e7) return 3.0;
  if (volume24h >= 1e6) return 2.0;
  return 1.0;
}

export interface MarketOverviewSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  markPrice: number;
  priceChange24h: number;
  volume24h: number;
  openInterest: number;
  liquidityScore: number;
}

export interface MarketOverviewPayload {
  totalOpenInterest: number;
  totalVolume24h: number;
  topByOpenInterest: MarketOverviewSymbol[];
  topByVolume: MarketOverviewSymbol[];
  mostLiquid: MarketOverviewSymbol[];
  updatedAt: string;
}

// Cache + single-flight wrapper with stale-while-revalidate.
//
// The raw `computeMarketOverview()` walks the full OKX instrument list and,
// for any symbol HL doesn't carry live, makes a per-symbol REST `fetchTicker`
// call. With ~400 instruments this pegs at 1.8–9s per request. Every caller
// (REST `/api/liquidity/market-overview` AND the wsHub broadcast tick) was
// paying that cost on every hit.
//
// Strategy:
//   • CACHE_TTL_MS (30 s) — within this age, return cached value, do nothing.
//   • SWR_GRACE_MS (5 min) — past 30 s but within 5 min, return cached value
//     INSTANTLY and trigger a background recompute. Replaces the old block-
//     and-wait pattern that made the first request after any 30 s idle gap
//     pay the full 1.8-9 s compute cost.
//   • Beyond 5 min OR cold cache — block on the in-flight compute (single-
//     flight de-dupes concurrent callers).
//   • startMarketOverviewWarm() (below) recomputes every 25 s on a timer,
//     so under steady load the cache age stays under CACHE_TTL_MS and even
//     the SWR path is rarely needed. The combined effect is "always hot."
//
// The aggregate is intentionally not engine state — no scoring/confluence/
// precision/regime logic flows through here, so this purely-infrastructure
// cache cannot drift any level math.
const CACHE_TTL_MS = 30_000;
const SWR_GRACE_MS = 5 * 60_000; // serve cached + bg-refresh up to 5 min
const WARM_INTERVAL_MS = Math.max(30_000, Number(process.env.MARKET_OVERVIEW_WARM_INTERVAL_MS ?? "60000") || 60_000);
const MARKET_OVERVIEW_WARM_ENABLED = process.env.ENABLE_MARKET_OVERVIEW_WARM === "1";
const MARKET_OVERVIEW_MAX_INSTRUMENTS = Math.max(10, Number(process.env.MARKET_OVERVIEW_MAX_INSTRUMENTS ?? "80") || 80);
const MARKET_OVERVIEW_PRIORITY = new Set(["BTC", "ETH", "SOL", "HYPE", "BNB", "XRP", "DOGE", "LINK", "AVAX", "SUI"]);
let cached: { value: MarketOverviewPayload; computedAt: number } | null = null;
let inflight: Promise<MarketOverviewPayload> | null = null;
let warmTimer: NodeJS.Timeout | null = null;
let warmStarted = false;

function recompute(): Promise<MarketOverviewPayload> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await computeMarketOverview();
      cached = { value: fresh, computedAt: Date.now() };
      return fresh;
    } catch (err) {
      // If recompute fails but we have any prior value, keep it as the
      // last-known-good. Bubble the error so the caller's catch can decide.
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getMarketOverviewCached(): Promise<MarketOverviewPayload> {
  const now = Date.now();
  // Hot path — cache fresh, no work.
  if (cached && now - cached.computedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  // SWR path — cache exists but stale. Serve it instantly, kick off a
  // background recompute. Any caller that arrives during recompute gets
  // the still-served stale value; only callers AFTER the recompute lands
  // get the fresh one. This is the right tradeoff for an aggregate that
  // refreshes every 25 s anyway.
  if (cached && now - cached.computedAt < SWR_GRACE_MS) {
    void recompute().catch(() => {
      // Background failure is fine — we already returned the cached value
      // and the next call (or warm tick) will retry.
    });
    return cached.value;
  }
  // Cold or beyond grace — must block. Single-flight protects against
  // thundering herd.
  try {
    return await recompute();
  } catch (err) {
    // Last-resort fallback: if a cached value exists at all (even >5min),
    // it beats throwing 500 to the user.
    if (cached) return cached.value;
    throw err;
  }
}

export function getMarketOverviewCacheAgeMs(): number | null {
  return cached ? Date.now() - cached.computedAt : null;
}

// Background warmer — keeps cache hot under steady load so the SWR path
// is rarely needed. Idempotent: calling startMarketOverviewWarm() twice
// is a no-op. Errors are swallowed (warm is best-effort).
export function startMarketOverviewWarm(): void {
  if (!MARKET_OVERVIEW_WARM_ENABLED) return;
  if (warmStarted) return;
  warmStarted = true;
  // First warm immediately so the cache is hot right after boot.
  void recompute().catch(() => {});
  warmTimer = setInterval(() => {
    void recompute().catch(() => {});
  }, WARM_INTERVAL_MS);
  // Don't block process exit.
  warmTimer.unref();
}

export async function computeMarketOverview(): Promise<MarketOverviewPayload> {
  const okxInstruments = await okx.fetchInstruments();
  // Prefer the live WS-fed asset cache so the overview channel reflects
  // every real exchange tick. The hot store is populated by the okx/hl
  // WS streams the moment a symbol gets touched, so it's <500ms fresh
  // for any symbol the system is actively tracking. We only fall back
  // to the 30s-cached REST snapshot when the live store is empty (e.g.
  // immediately after a cold restart, before any subscriber has touched
  // a symbol yet).
  const live = hlStore.listAssets();
  const hlAssets = live.size > 0 ? live : await hl.fetchAllAssets();

  // Honest empty: no real instruments => empty overview. The frontend
  // renders this as a loading/empty state rather than fabricating stats.
  // We prefer HL (real-time WS-fed) and fall back to OKX REST tickers
  // for symbols HL doesn't list, matching the `/symbols` route policy.
  let symbols: MarketOverviewSymbol[] = [];
  if (okxInstruments && okxInstruments.length > 0) {
    const prioritizedInstruments = [...okxInstruments]
      .sort((a, b) => {
        const ap = MARKET_OVERVIEW_PRIORITY.has(a.baseAsset.toUpperCase()) ? 0 : 1;
        const bp = MARKET_OVERVIEW_PRIORITY.has(b.baseAsset.toUpperCase()) ? 0 : 1;
        return ap - bp;
      })
      .slice(0, MARKET_OVERVIEW_MAX_INSTRUMENTS);
    const tickerEntries = await Promise.all(
      prioritizedInstruments.map(async (inst): Promise<MarketOverviewSymbol | null> => {
        const hlData = hlAssets?.get(inst.baseAsset.toUpperCase());
        if (hlData && hlData.markPx > 0) {
          const change =
            hlData.prevDayPx > 0
              ? ((hlData.markPx - hlData.prevDayPx) / hlData.prevDayPx) * 100
              : 0;
          const volume24h = hlData.dayNtlVlm;
          return {
            symbol: inst.symbol,
            baseAsset: inst.baseAsset,
            quoteAsset: "USDT",
            markPrice: hlData.markPx,
            priceChange24h: parseFloat(change.toFixed(2)),
            volume24h,
            openInterest: hlData.openInterest * hlData.markPx,
            liquidityScore: deriveLiquidityScore(volume24h),
          };
        }
        const t = await okx.fetchTicker(inst.symbol);
        if (!t) return null;
        const markPrice = parseFloat(t.last);
        if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
        const open24h = parseFloat(t.open24h);
        const change = open24h > 0 ? ((markPrice - open24h) / open24h) * 100 : 0;
        const volume24h = parseFloat(t.volCcy24h) * markPrice;
        return {
          symbol: inst.symbol,
          baseAsset: inst.baseAsset,
          quoteAsset: "USDT",
          markPrice,
          priceChange24h: parseFloat(change.toFixed(2)),
          volume24h: Number.isFinite(volume24h) ? volume24h : 0,
          openInterest: 0,
          liquidityScore: deriveLiquidityScore(Number.isFinite(volume24h) ? volume24h : 0),
        };
      }),
    );
    symbols = tickerEntries.filter((s): s is MarketOverviewSymbol => s !== null);
  }

  const totalOpenInterest = symbols.reduce((sum, s) => sum + s.openInterest, 0);
  const totalVolume24h = symbols.reduce((sum, s) => sum + s.volume24h, 0);

  return {
    totalOpenInterest,
    totalVolume24h,
    topByOpenInterest: [...symbols]
      .sort((a, b) => b.openInterest - a.openInterest)
      .slice(0, 10),
    topByVolume: [...symbols]
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 10),
    mostLiquid: [...symbols]
      .sort((a, b) => b.liquidityScore - a.liquidityScore)
      .slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}
