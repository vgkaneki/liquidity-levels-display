import {
  fetchL2Book,
  fetchTrades,
  fetchMetaAndCtxs,
  intervalToLookbackMs,
  candlesToOhlcv,
} from "./hyperliquid";
// Candle reads go through candleSource so the levels engine
// transparently falls back to Toobit when Hyperliquid returns
// empty/null/429/5xx for a symbol — see services/candleSource.ts and
// .local/tasks/toobit-candle-fallback.md. Other HL reads (book, trades,
// metaAndCtxs) stay on the direct HL client because the fallback story
// in this task is candles-only.
import { fetchCandles, fetchCandlesSourced, type CandleSource } from "./candleSource";
import {
  hurstExponent,
  regimeFromHurst,
  garchVolatility,
  garchRegime,
  rollingGarchHistory,
  logReturns,
} from "./engines/regime";
import {
  findPivots,
  kde,
  kdePeaks,
  buildPriceGrid,
  marketProfile,
  validateLevel,
  computeAtr,
  recencyWeights,
} from "./engines/levels";
import { computeVpin, computeObi } from "./engines/orderflow";
import { recordOrderFlow, sustainedOrderFlow } from "./orderflowBuffer";
import { mergeIntoZones, type RawLevel, type RawZone } from "./engines/confluence";
import { pickPrecisionEntry } from "./engines/precision";
import { confirmZone, findDivergences } from "./engines/reliability";
import { computeCrossPairZScores } from "./engines/crosspair";
import { quantileBands } from "./engines/quantile";
import { synthesize } from "./ai/synthesis";
import { TtlCache, type CachedResult } from "./cache";
import { AsyncLocalStorage } from "node:async_hooks";

// ---- Per-request stage timing (pure observability, additive) ----
// Captures wall-clock timings for the three stages the route plan calls
// out — upstream fetches for the primary symbol, recursive HTF + peer
// zone computes, and the foreground engine. The route creates a fresh
// collector per request and runs `getCachedLevels` inside its ALS scope;
// `computeLevelsData` appends timings on a cache miss. On a cache hit the
// collector stays empty and the route emits the line with zeros so we
// always have one structured timing record per `/api/levels` request.
export interface LevelsTimingCollector {
  // Max wall-clock among the pure HL fetches (candles, l2book, trades)
  // for the primary symbol. They run concurrently inside one Promise.all
  // so wall-clock equals the longest, which is the right number for
  // "how long did upstream IO take this request".
  upstreamMs: number | null;
  // Max wall-clock among the recursive HTF/peer zone computes (each of
  // which internally fetches HL candles + runs computeZonesOnly).
  htfPeerMs: number | null;
  // Wall-clock for everything after the IO Promise.all settles.
  engineMs: number | null;
  // Total wall-clock from entry of computeLevelsData to its return.
  computeMs: number | null;
  peers: number;
  higherTf: string | null;
}

export function createLevelsTimingCollector(): LevelsTimingCollector {
  return { upstreamMs: null, htfPeerMs: null, engineMs: null, computeMs: null, peers: 0, higherTf: null };
}

const timingStorage = new AsyncLocalStorage<LevelsTimingCollector | undefined>();

export function runWithLevelsTimingCollector<T>(
  collector: LevelsTimingCollector,
  fn: () => Promise<T>,
): Promise<T> {
  return timingStorage.run(collector, fn);
}

function currentTimingCollector(): LevelsTimingCollector | undefined {
  return timingStorage.getStore();
}

const LEVELS_TTL_MS = 30_000;
const REGIME_TTL_MS = 60_000;
const PROFILE_TTL_MS = 60_000;
const CROSSPAIR_TTL_MS = 60_000;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

type EngineBar = ReturnType<typeof candlesToOhlcv>[number];
function isEngineBar(bar: EngineBar | undefined): bar is EngineBar {
  return !!bar &&
    finite(bar.time) &&
    finite(bar.open) &&
    finite(bar.high) &&
    finite(bar.low) &&
    finite(bar.close) &&
    finite(bar.volume) &&
    bar.high >= bar.low &&
    bar.close > 0;
}

function sanitizeOhlcv(bars: ReturnType<typeof candlesToOhlcv>): ReturnType<typeof candlesToOhlcv> {
  return bars.filter(isEngineBar);
}

function finitePrices(values: number[]): number[] {
  return values.filter((x) => finite(x) && x > 0);
}

const levelsCache = new TtlCache<Awaited<ReturnType<typeof computeLevelsData>>>(LEVELS_TTL_MS);
const regimeCache = new TtlCache<Awaited<ReturnType<typeof computeRegimeData>>>(REGIME_TTL_MS);
const profileCache = new TtlCache<Awaited<ReturnType<typeof computeMarketProfileData>>>(PROFILE_TTL_MS);
// Cross-pair correlation is universe-wide (BTC/ETH/SOL pairs only — see
// crosspair.ts) so it has a single cache key. Without this wrapper the
// /api/cross-correlation route re-fetched 90 days of daily candles for
// each major on every request, and computeLevelsData hit the same path
// inline once per cache miss. 60 s TTL + 60 s SWR matches /api/regime
// and means the underlying daily candles are pulled at most once per
// minute regardless of how many callers ask.
const crossPairCache = new TtlCache<Awaited<ReturnType<typeof computeCrossPairZScores>>>(CROSSPAIR_TTL_MS);

export function getCachedLevels(symbol: string, interval: string): Promise<CachedResult<Awaited<ReturnType<typeof computeLevelsData>>>> {
  return levelsCache.get(`${symbol}|${interval}`, () => computeLevelsData(symbol, interval));
}
export function getCachedRegime(symbol: string, interval: string): Promise<CachedResult<Awaited<ReturnType<typeof computeRegimeData>>>> {
  return regimeCache.get(`${symbol}|${interval}`, () => computeRegimeData(symbol, interval));
}
export function getCachedMarketProfile(symbol: string, interval: string): Promise<CachedResult<Awaited<ReturnType<typeof computeMarketProfileData>>>> {
  return profileCache.get(`${symbol}|${interval}`, () => computeMarketProfileData(symbol, interval));
}
export function getCachedCrossPair(): Promise<CachedResult<Awaited<ReturnType<typeof computeCrossPairZScores>>>> {
  return crossPairCache.get("crosspair:all", () => computeCrossPairZScores());
}

// Background-warm a (symbol, interval) so foreground requests stay cache-hot.
const refreshHandles = new Map<string, () => void>();
export function scheduleLevelsRefresh(symbol: string, interval: string): void {
  const key = `${symbol}|${interval}`;
  if (refreshHandles.has(key)) return;
  const stop = levelsCache.scheduleRefresh(key, () =>
    computeLevelsData(symbol, interval),
  );
  refreshHandles.set(key, stop);
}
// Stop a previously-scheduled levels refresh. Symmetric with
// stopOhlcvRefresh so the dynamic warmer in index.ts can retire entries
// that fall out of the top-N over time, preventing unbounded background
// HL load under symbol churn.
export function stopLevelsRefresh(symbol: string, interval: string): void {
  const key = `${symbol}|${interval}`;
  const stop = refreshHandles.get(key);
  if (!stop) return;
  stop();
  refreshHandles.delete(key);
}
export function listActiveLevelsWarmKeys(): string[] {
  return Array.from(refreshHandles.keys());
}

// Higher-timeframe used to confirm zones found at the requested interval.
// FIXED across intervals so that the overlay levels stay anchored in the
// same prices regardless of which chart timeframe the user is viewing —
// 1d for everything except the daily view itself, which uses 1w.
function higherTfFor(interval: string): string {
  return interval === "1d" || interval === "1w" ? "1w" : "1d";
}

// Cross-asset peer set for zone co-confirmation. A BTC zone is more
// reliable when ETH has a similar zone at the same %-distance from price.
const CROSS_ASSET_PEERS: Record<string, string[]> = {
  BTC: ["ETH"],
  ETH: ["BTC"],
  SOL: ["BTC", "ETH"],
};

// Per-symbol rolling history of funding & open-interest snapshots, used to
// compute z-scores and divergence states across calls. Capped at 200 entries
// per symbol to bound memory.
const fundingHistory = new Map<string, Array<{ t: number; funding: number; oi: number }>>();
function pushSnapshot(symbol: string, funding: number, oi: number) {
  const arr = fundingHistory.get(symbol) ?? [];
  arr.push({ t: Date.now(), funding, oi });
  while (arr.length > 200) arr.shift();
  fundingHistory.set(symbol, arr);
}
function fundingZScore(symbol: string, current: number): number {
  const arr = fundingHistory.get(symbol) ?? [];
  if (arr.length < 5) return 0;
  const xs = arr.map((s) => s.funding);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  const sigma = Math.sqrt(variance) || 1e-9;
  return (current - mean) / sigma;
}
function oiDivergenceState(symbol: string, currentOi: number, priceChange: number):
  "long-buildup" | "short-buildup" | "long-unwind" | "short-unwind" | "neutral" {
  const arr = fundingHistory.get(symbol) ?? [];
  if (arr.length < 3) return "neutral";
  const prevOi = arr[arr.length - 2]?.oi ?? currentOi;
  const oiDelta = currentOi - prevOi;
  if (Math.abs(oiDelta) < Math.max(1, prevOi * 0.001) || priceChange === 0) return "neutral";
  if (oiDelta > 0 && priceChange > 0) return "long-buildup";
  if (oiDelta > 0 && priceChange < 0) return "short-buildup";
  if (oiDelta < 0 && priceChange > 0) return "short-unwind";
  return "long-unwind";
}

async function computeRegimeData(symbol: string, interval: string) {
  const lookback = intervalToLookbackMs(interval, 400);
  const candles = await fetchCandles(symbol, interval, lookback);
  const ohlcv = sanitizeOhlcv(candlesToOhlcv(candles));
  const closes = finitePrices(ohlcv.map((b) => b.close));
  const returns = logReturns(closes);
  const h = hurstExponent(returns);
  const reg = regimeFromHurst(h);
  const vol = garchVolatility(returns);
  const history = rollingGarchHistory(returns, 50);
  const garchLabel = garchRegime(vol, history);
  return {
    symbol,
    interval,
    hurst: h,
    regimeLabel: reg.label,
    signalWeightMultiplier: reg.multiplier,
    garchVolatility: vol,
    garchRegime: garchLabel,
  };
}

async function computeMarketProfileData(symbol: string, interval: string) {
  const lookback = intervalToLookbackMs(interval, 200);
  const candles = await fetchCandles(symbol, interval, lookback);
  const ohlcv = sanitizeOhlcv(candlesToOhlcv(candles));
  return marketProfile(ohlcv, 60);
}

// Compute a stripped-down zone list at a given timeframe — used as a
// confluence/confirmation source for the primary timeframe. Excludes order
// flow, AI, and other heavy work.
async function computeZonesOnly(
  symbol: string,
  interval: string,
): Promise<RawZone[]> {
  const lookback = intervalToLookbackMs(interval, 400);
  const candles = await fetchCandles(symbol, interval, lookback);
  const ohlcv = sanitizeOhlcv(candlesToOhlcv(candles));
  if (ohlcv.length < 30) return [];
  const closes = finitePrices(ohlcv.map((b) => b.close));
  if (closes.length < 30) return [];
  const currentPrice = closes[closes.length - 1] ?? 0;
  const returns = logReturns(closes);
  const vol = garchVolatility(returns);
  const atr = computeAtr(ohlcv, 14);

  const pivots = findPivots(ohlcv, 3);
  const reversalPrices = [
    ...pivots.highs.map((b) => b.high),
    ...pivots.lows.map((b) => b.low),
  ];
  const lo = Math.min(...closes) * 0.995;
  const hi = Math.max(...closes) * 1.005;
  const grid = buildPriceGrid(lo, hi, 200);
  const weights = recencyWeights(reversalPrices.length, 1.5);
  const volScale = 1 + Math.min(2, vol * 50);
  const density = reversalPrices.length
    ? kde(reversalPrices, grid, undefined, weights, volScale)
    : grid.map(() => 0);
  const peaks = kdePeaks(grid, density, 6).slice(0, 12);

  const tolerance = Math.max((hi - lo) * 0.003, atr * 0.25);
  const raw: RawLevel[] = [];
  for (const pk of peaks) {
    raw.push({
      price: pk.price,
      method: "kde-pivot-cluster",
      kind: pk.price < currentPrice ? "support" : "resistance",
      strength: Math.min(1, pk.density * 100),
      validated: false,
      bounceRate: null, pValue: null, touches: null,
    });
  }
  // Include POC, value-area edges, recent swing pivots so the higher TF
  // surfaces enough zone candidates for overlap matching.
  const mp = marketProfile(ohlcv, 60);
  if (mp.poc) raw.push({ price: mp.poc, method: "market-profile-poc", kind: mp.poc < currentPrice ? "support" : "resistance", strength: 0.8, validated: false, bounceRate: null, pValue: null, touches: null });
  if (mp.valueAreaHigh) raw.push({ price: mp.valueAreaHigh, method: "value-area-high", kind: "resistance", strength: 0.5, validated: false, bounceRate: null, pValue: null, touches: null });
  if (mp.valueAreaLow) raw.push({ price: mp.valueAreaLow, method: "value-area-low", kind: "support", strength: 0.5, validated: false, bounceRate: null, pValue: null, touches: null });
  for (const high of pivots.highs.slice(-10)) raw.push({ price: high.high, method: "swing-pivot", kind: "resistance", strength: 0.4, validated: false, bounceRate: null, pValue: null, touches: null });
  for (const low of pivots.lows.slice(-10)) raw.push({ price: low.low, method: "swing-pivot", kind: "support", strength: 0.4, validated: false, bounceRate: null, pValue: null, touches: null });
  const proximityPct = Math.max(0.002, Math.min(0.008, vol * 2));
  return mergeIntoZones(raw, proximityPct);
}

async function computeLevelsData(symbol: string, interval: string) {
  const lookback = intervalToLookbackMs(interval, 500);
  const higherTf = higherTfFor(interval);

  // Per-stage timing — pure observability around existing call boundaries.
  // Each branch of the Promise.all is wrapped in its own performance.now()
  // pair so we can separate "pure upstream HL fetches for the primary
  // symbol" (candles/book/trades) from "recursive HTF + peer compute"
  // (computeZonesOnly, which itself fetches HL candles). Inside one
  // Promise.all the branches run concurrently, so per-branch wall-clock
  // equals "how long did this branch take given the contention" — which
  // is the right number for picking a lever. No engine math is touched.
  const tStart = performance.now();
  const peers = CROSS_ASSET_PEERS[symbol] ?? [];
  async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const t0 = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - t0 };
  }
  const [
    candlesT, bookT, tradesT, higherT, peerT,
  ] = await Promise.all([
    // Sourced variant on the primary symbol so the response can carry
    // a `dataSource` tag for the chart toolbar. Other internal fetches
    // (HTF, peers, book, trades) don't need the tag — they only feed
    // confluence/order-flow signals and never surface to the UI.
    timed(() => fetchCandlesSourced(symbol, interval, lookback)),
    timed(() => fetchL2Book(symbol).catch(() => ({ coin: symbol, time: Date.now(), levels: [[], []] as [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>] }))),
    timed(() => fetchTrades(symbol).catch(() => [] as Array<{ coin: string; side: "A" | "B"; px: string; sz: string; time: number; hash: string; tid: number }>)),
    timed(() => higherTf ? computeZonesOnly(symbol, higherTf).catch(() => [] as RawZone[]) : Promise.resolve([] as RawZone[])),
    timed(() => Promise.all(peers.map(async (p) => {
      try {
        const lb = intervalToLookbackMs(interval, 400);
        const cs = await fetchCandles(p, interval, lb);
        const ohlcvP = sanitizeOhlcv(candlesToOhlcv(cs));
        const peerPrice = ohlcvP[ohlcvP.length - 1]?.close ?? 0;
        const zs = await computeZonesOnly(p, interval);
        return { peer: p, peerPrice, zones: zs };
      } catch { return { peer: p, peerPrice: 0, zones: [] as RawZone[] }; }
    }))),
  ]);
  const candles = candlesT.value.candles;
  const dataSource: CandleSource = candlesT.value.source;
  const book = bookT.value;
  const trades = tradesT.value;
  const higherZones = higherT.value;
  const peerZonesArr = peerT.value;
  const tUpstream = performance.now();
  // upstream = pure HL fetches for the primary symbol (max of the three
  // concurrent branches). htfPeer = recursive zone computes (HTF + peer
  // group max). The two stage buckets are reported separately so the
  // observer can tell if the next regression is in HL fan-out vs. the
  // recursive compute layer.
  const upstreamBranchMs = Math.max(candlesT.ms, bookT.ms, tradesT.ms);
  const htfPeerBranchMs = Math.max(higherT.ms, peerT.ms);

  // Hyperliquid occasionally returns `null` (rather than `[]`) for symbols
  // it doesn't list — coerce both to an empty array so the `unsupported`
  // branch below catches "empty/null upstream candles" uniformly.
  const ohlcv = Array.isArray(candles) ? sanitizeOhlcv(candlesToOhlcv(candles)) : [];
  if (ohlcv.length === 0) {
    // Symbol has no upstream data on Hyperliquid (e.g. MATIC, EDU). Return
    // a cacheable "unsupported" sentinel instead of throwing — the route
    // serializes this as a 200 with `unsupported: true` so the chart can
    // surface a friendly inline note instead of a generic 502.
    const collector = currentTimingCollector();
    if (collector) {
      collector.upstreamMs = Math.round(upstreamBranchMs);
      collector.htfPeerMs = Math.round(htfPeerBranchMs);
      collector.engineMs = 0;
      collector.computeMs = Math.round(performance.now() - tStart);
      collector.peers = peers.length;
      collector.higherTf = higherTf;
    }
    return {
      symbol,
      interval,
      currentPrice: 0,
      regime: {
        symbol, interval, hurst: 0, regimeLabel: "unknown",
        signalWeightMultiplier: 1, garchVolatility: 0, garchRegime: "normal" as const,
      },
      levels: [] as Array<{
        price: number; method: string; kind: "support" | "resistance" | "neutral";
        strength: number; validated: boolean; bounceRate: number | null;
        pValue: number | null; touches: number | null; lastTouchAge: number | null; isStale: boolean;
      }>,
      zones: [] as Array<{
        priceLow: number; priceHigh: number; score: number;
        kind: "support" | "resistance" | "neutral"; methods: string[];
        preciseEntryPrice: number; entryMethod: string;
        bounceRate: number | null; pValue: number | null; posteriorBounceRate: number | null;
        confirmed: boolean; confirmingTimeframe: string | null;
        crossAssetConfirmed: boolean; confidence: "high" | "medium" | "low";
      }>,
      signals: [] as Array<{ name: string; value: number; label: string; direction: string }>,
      divergences: [] as Array<{ time: number; price: number; kind: string; magnitude: number }>,
      kde: [] as Array<{ price: number; density: number }>,
      liquidations: [] as Array<{ price: number; density: number; leverage: number }>,
      ai: undefined as
        | undefined
        | { summary: string; confidence: "HIGH" | "MEDIUM" | "LOW"; recommendedEntry: number | null; direction: "long" | "short" | "neutral"; reasoning: string[]; consistency: string },
      generatedAt: Date.now(),
      unsupported: true as const,
      // No source could produce bars for this symbol — leave the field
      // null so the frontend hides the source pill rather than mis-
      // attributing the empty result to a specific exchange.
      dataSource: null as CandleSource | null,
    };
  }
  const closes = finitePrices(ohlcv.map((b) => b.close));
  const currentPrice = closes[closes.length - 1] ?? 0;
  if (closes.length === 0 || currentPrice <= 0) throw new Error(`no valid OHLCV bars for ${symbol} ${interval}`);
  const returns = logReturns(closes);

  const h = hurstExponent(returns);
  const reg = regimeFromHurst(h);
  const vol = garchVolatility(returns);
  const history = rollingGarchHistory(returns, 50);
  const garchLabel = garchRegime(vol, history);
  const regime = {
    symbol, interval, hurst: h, regimeLabel: reg.label,
    signalWeightMultiplier: reg.multiplier,
    garchVolatility: vol, garchRegime: garchLabel,
  };

  // ATR drives bounce-magnitude normalization and zone tolerance.
  const atr = computeAtr(ohlcv, 14);

  // KDE of swing pivots, weighted by recency, with vol-adaptive bandwidth so
  // we get sharper density in calm regimes and smoother density in volatile
  // ones (avoiding spurious peaks). Pivots are merged in *chronological*
  // order so recency weights line up with bar order.
  const pivots = findPivots(ohlcv, 3);
  const timeToIdx = new Map<number, number>();
  for (let i = 0; i < ohlcv.length; i++) timeToIdx.set(ohlcv[i]!.time, i);
  const idxOf = (b: { time: number }): number => timeToIdx.get(b.time) ?? -1;
  const chronoPivots: Array<{ idx: number; price: number; kind: "high" | "low" }> = [
    ...pivots.highs.map((b) => ({ idx: idxOf(b), price: b.high, kind: "high" as const })),
    ...pivots.lows.map((b) => ({ idx: idxOf(b), price: b.low, kind: "low" as const })),
  ].sort((a, b) => a.idx - b.idx);
  const reversalPrices = chronoPivots.map((p) => p.price);
  const lo = Math.min(...closes) * 0.995;
  const hi = Math.max(...closes) * 1.005;
  const grid = buildPriceGrid(lo, hi, 200);
  const pivotWeights = recencyWeights(reversalPrices.length, 1.5);
  const volScale = 1 + Math.min(2, vol * 50);
  const density = reversalPrices.length > 0
    ? kde(reversalPrices, grid, undefined, pivotWeights, volScale)
    : grid.map(() => 0);
  const kdePoints = grid.map((p, i) => ({ price: p, density: density[i] ?? 0 }));
  const peaks = kdePeaks(grid, density, 6).slice(0, 12);

  // Per-level detection-index helper: the most recent contributing pivot's
  // bar index. Touches at indices ≥ this are true out-of-sample.
  function detectionIdxFor(price: number, tol: number): number {
    let lastIdx = -1;
    for (const p of chronoPivots) {
      if (Math.abs(p.price - price) <= tol) lastIdx = p.idx;
    }
    // Fall back to a 70/30 split when no pivot directly contributed.
    if (lastIdx < 0) lastIdx = Math.floor(ohlcv.length * 0.7);
    return lastIdx;
  }

  // Market profile. Spec: TPO over the last 60 bars (lookback), with the
  // function's default 80 price bins. Earlier this call passed 60 as the
  // bin count and consumed the full 500-bar window — that drifted from
  // the intended "more local on smaller timeframes" behavior.
  const mp = marketProfile(ohlcv.slice(-60));

  // Build raw levels from multiple sources. Tolerance is the larger of a
  // fixed range fraction and 0.25 * ATR.
  const tolerance = Math.max((hi - lo) * 0.003, atr * 0.25);
  const STALE_BARS = 200;
  const baseOpts = { atr, staleBars: STALE_BARS };
  const rawLevels: Array<RawLevel & { lastTouchAge: number; isStale: boolean }> = [];

  // Validation gate: posterior bounce rate ≥ 0.6 AND raw bounce rate ≥ 0.6
  // AND pValue < 0.1. The posterior shrinks low-evidence levels toward 0.5.
  const gate = (v: ReturnType<typeof validateLevel>) =>
    v.touches >= 3 && v.posteriorBounceRate >= 0.6 && v.bounceRate >= 0.6 && v.pValue < 0.1 && !v.isStale;
  const gateLight = (v: ReturnType<typeof validateLevel>) =>
    v.touches >= 2 && v.posteriorBounceRate >= 0.6 && v.bounceRate >= 0.6 && v.pValue < 0.15 && !v.isStale;

  function pushLevel(
    price: number,
    method: string,
    strength: number,
    detectionIndex: number,
    isLight: boolean,
  ): void {
    const v = validateLevel(ohlcv, price, tolerance, 5, 2, { ...baseOpts, detectionIndex });
    rawLevels.push({
      price,
      method,
      kind: price < currentPrice ? "support" : "resistance",
      strength,
      validated: (isLight ? gateLight : gate)(v),
      bounceRate: v.touches > 0 ? v.posteriorBounceRate : null,
      pValue: v.touches > 0 ? v.pValue : null,
      touches: v.touches,
      lastTouchAge: v.lastTouchAge,
      isStale: v.isStale,
    });
  }

  for (const pk of peaks) {
    pushLevel(
      pk.price,
      "kde-pivot-cluster",
      Math.min(1, pk.density * 100) * reg.multiplier,
      detectionIdxFor(pk.price, tolerance),
      false,
    );
  }

  if (mp.poc) {
    pushLevel(mp.poc, "market-profile-poc", 0.9 * reg.multiplier, Math.floor(ohlcv.length * 0.7), false);
  }
  for (const [price, name] of [
    [mp.valueAreaHigh, "value-area-high"],
    [mp.valueAreaLow, "value-area-low"],
  ] as Array<[number, string]>) {
    if (!price) continue;
    pushLevel(price, name, 0.6 * reg.multiplier, Math.floor(ohlcv.length * 0.7), false);
  }

  const qbands = quantileBands(closes);
  for (const qb of qbands) {
    pushLevel(qb.price, "quantile-band", 0.55 * reg.multiplier, Math.floor(ohlcv.length * 0.7), true);
  }

  for (const high of pivots.highs.slice(-6)) {
    pushLevel(high.high, "swing-pivot", 0.5 * reg.multiplier, idxOf(high), true);
  }
  for (const low of pivots.lows.slice(-6)) {
    pushLevel(low.low, "swing-pivot", 0.5 * reg.multiplier, idxOf(low), true);
  }

  // Adaptive merge proximity: scales with GARCH vol so we don't over-merge
  // levels in calm regimes nor under-merge in volatile ones.
  const proximityPct = Math.max(0.001, Math.min(0.005, vol * 1.5));
  const rawZones = mergeIntoZones(rawLevels, proximityPct);

  // Live order-flow signals — snapshot, then folded into a per-symbol
  // rolling window so we can require SUSTAINED imbalance.
  const obi = computeObi(book, 10);
  const recentVolBars = ohlcv.slice(-50);
  const lastVol = recentVolBars.length
    ? recentVolBars.reduce((s, b) => s + Math.max(0, b.volume), 0) / recentVolBars.length
    : 0;
  const vpin = computeVpin(trades, Math.max(lastVol * 0.05, 1), 30);
  recordOrderFlow(symbol, obi, vpin);
  const sustained = sustainedOrderFlow(symbol);
  // "Sustained" = at least 5 samples and ≥40% of recent samples on the
  // same side. Snapshots alone don't move the gate.
  const sustainedThreshold = 0.4;
  const sustainedSamples = sustained.samples >= 5;
  const sustainedBidHeavy = sustainedSamples && sustained.fracObiBidHeavy >= sustainedThreshold;
  const sustainedAskHeavy = sustainedSamples && sustained.fracObiAskHeavy >= sustainedThreshold;

  // Order flow as a first-class validation gate. Within 2% of price,
  // SUSTAINED OBI agreement gives a bonus; SUSTAINED disagreement applies
  // a VPIN-amplified penalty — toxic flow against zone direction is a
  // real warning sign and should not be triggered by single-tick spikes.
  function orderFlowAdjust(zMid: number, zKind: "support" | "resistance" | "neutral"): number {
    const proximity = Math.abs(zMid - currentPrice) / Math.max(currentPrice, 1);
    if (proximity > 0.02) return 0;
    const proxFactor = 1 - proximity / 0.02;
    const meanObi = sustained.meanObi;
    const meanVpin = sustained.meanVpin;
    const agree =
      (zKind === "support" && sustainedBidHeavy) ||
      (zKind === "resistance" && sustainedAskHeavy)
        ? Math.min(1, Math.abs(meanObi) / 0.3)
        : 0;
    const disagree =
      (zKind === "support" && sustainedAskHeavy) ||
      (zKind === "resistance" && sustainedBidHeavy)
        ? Math.min(1, Math.abs(meanObi) / 0.3)
        : 0;
    const vpinAmp = meanVpin > 0.25 ? 1 + Math.min(1, (meanVpin - 0.25) / 0.25) : 1;
    const bonus = proxFactor * agree * vpinAmp * 0.8;
    const penalty = proxFactor * disagree * vpinAmp * 0.6;
    return bonus - penalty;
  }

  // Cross-asset zone co-confirmation: a BTC zone is more reliable when
  // ETH (or another peer) has a same-kind zone at a similar %-distance
  // from price. Compare normalized distance from current price.
  function crossAssetMatch(zMid: number, zKind: "support" | "resistance" | "neutral"): boolean {
    if (peerZonesArr.length === 0) return false;
    const ourPct = (zMid - currentPrice) / Math.max(currentPrice, 1);
    for (const peer of peerZonesArr) {
      if (peer.peerPrice <= 0) continue;
      for (const pz of peer.zones) {
        if (pz.kind !== zKind) continue;
        const peerMid = (pz.priceLow + pz.priceHigh) / 2;
        const peerPct = (peerMid - peer.peerPrice) / Math.max(peer.peerPrice, 1);
        if (Math.abs(ourPct - peerPct) <= 0.005) return true;
      }
    }
    return false;
  }

  // Zone overlap helper for multi-timeframe confluence. Allows a small
  // tolerance pad (max of 0.2% of price or ATR/2) so near-misses on
  // adjacent-but-not-touching ranges still count as confluence.
  const overlapPad = Math.max(currentPrice * 0.002, atr * 0.5);
  function overlapsHigher(zLow: number, zHigh: number): RawZone | null {
    for (const hz of higherZones) {
      if (hz.priceLow - overlapPad <= zHigh && hz.priceHigh + overlapPad >= zLow) return hz;
    }
    return null;
  }
  // Stale-zone decay: drop any zone whose contributing levels have all gone
  // untouched in the last STALE_BARS bars. We re-check against the level
  // store via tolerance match so we don't need RawLevel to carry isStale.
  function zoneIsStale(z: RawZone): boolean {
    const contributing = rawLevels.filter(
      (l) => l.price >= z.priceLow - tolerance && l.price <= z.priceHigh + tolerance,
    );
    if (contributing.length === 0) return true;
    return contributing.every((l) => l.isStale);
  }

  const zones = rawZones
    .filter((z) => !zoneIsStale(z))
    .map((z) => {
      const mid = (z.priceLow + z.priceHigh) / 2;
      const ofAdj = orderFlowAdjust(mid, z.kind);
      const higher = overlapsHigher(z.priceLow, z.priceHigh);
      const xAsset = crossAssetMatch(mid, z.kind);
      // Multi-TF confluence and cross-asset agreement each get a 30% / 20%
      // score boost. Penalties from order flow can still subtract.
      const tfBonus = higher ? z.score * 0.3 : 0;
      const xaBonus = xAsset ? z.score * 0.2 : 0;
      return {
        ...z,
        score: z.score + ofAdj + tfBonus + xaBonus,
        confirmingTimeframe: higher ? higherTf : null,
        crossAssetConfirmed: xAsset,
      };
    })
    .filter((z) => z.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((z) => {
      const mid = (z.priceLow + z.priceHigh) / 2;
      const entry = pickPrecisionEntry(ohlcv, trades, book, z.priceLow, z.priceHigh, mid);
      const confirmed = confirmZone(ohlcv, z.priceLow, z.priceHigh, z.kind);
      const posteriorBounceRate = z.bounceRate;
      // Confidence tier per spec: HIGH only when confirmed AND
      // higher-TF-supported. MEDIUM if exactly one. LOW otherwise. The
      // dashboard surfaces this so single-TF zones are visibly de-emphasised.
      const supports = (confirmed ? 1 : 0) + (z.confirmingTimeframe ? 1 : 0) + (z.crossAssetConfirmed ? 1 : 0);
      const confidence: "high" | "medium" | "low" =
        supports >= 2 ? "high" : supports === 1 ? "medium" : "low";
      return {
        priceLow: z.priceLow,
        priceHigh: z.priceHigh,
        score: z.score,
        kind: z.kind,
        methods: z.methods,
        preciseEntryPrice: entry.price,
        entryMethod: entry.method,
        bounceRate: z.bounceRate,
        pValue: z.pValue,
        posteriorBounceRate,
        confirmed,
        confirmingTimeframe: z.confirmingTimeframe,
        crossAssetConfirmed: z.crossAssetConfirmed,
        confidence,
      };
    });

  let funding = 0;
  let openInterest = 0;
  try {
    const [meta, ctxs] = await fetchMetaAndCtxs();
    const idx = meta.universe.findIndex((u) => u.name === symbol);
    if (idx >= 0 && ctxs[idx]) {
      funding = parseFloat(ctxs[idx].funding) || 0;
      openInterest = parseFloat(ctxs[idx].openInterest) || 0;
    }
  } catch {
    /* tolerate metadata failure */
  }
  pushSnapshot(symbol, funding, openInterest);
  const fundingZ = fundingZScore(symbol, funding);

  const cvd = trades.reduce((s, t) => {
    const sz = Number.isFinite(parseFloat(t.sz)) ? Math.max(0, parseFloat(t.sz)) : 0;
    return s + (t.side === "B" ? sz : -sz);
  }, 0);
  const recentBars = ohlcv.slice(-20);
  const priceChange = recentBars.length
    ? (recentBars[recentBars.length - 1]?.close ?? currentPrice) - (recentBars[0]?.close ?? currentPrice)
    : 0;
  const cvdDivergence =
    Math.sign(cvd) !== 0 && Math.sign(priceChange) !== 0 && Math.sign(cvd) !== Math.sign(priceChange);

  const signals = [
    { name: "Hurst", value: h, label: reg.label, direction: h < 0.45 ? "weakening" : h > 0.55 ? "strengthening" : "neutral" },
    { name: "GARCH Vol", value: vol, label: garchLabel, direction: garchLabel === "high" ? "strengthening" : garchLabel === "low" ? "weakening" : "neutral" },
    { name: "VPIN", value: vpin, label: vpin > 0.4 ? "toxic" : vpin > 0.25 ? "elevated" : "calm", direction: vpin > 0.4 ? "strengthening" : "neutral" },
    { name: "OBI", value: obi, label: obi > 0.15 ? "bid-heavy" : obi < -0.15 ? "ask-heavy" : "balanced", direction: Math.abs(obi) > 0.15 ? "strengthening" : "neutral" },
    {
      name: "Funding",
      value: funding,
      label:
        Math.abs(fundingZ) >= 2
          ? `extreme (z=${fundingZ.toFixed(2)})`
          : Math.abs(fundingZ) >= 1
            ? `elevated (z=${fundingZ.toFixed(2)})`
            : funding > 0.0001
              ? "longs paying"
              : funding < -0.0001
                ? "shorts paying"
                : "neutral",
      direction: Math.abs(fundingZ) >= 1 ? "strengthening" : "neutral",
    },
    {
      name: "Open Interest",
      value: openInterest,
      label:
        openInterest > 0
          ? oiDivergenceState(symbol, openInterest, priceChange)
          : "n/a",
      direction:
        openInterest > 0 &&
        oiDivergenceState(symbol, openInterest, priceChange) !== "neutral"
          ? "strengthening"
          : "neutral",
    },
    { name: "CVD", value: cvd, label: cvdDivergence ? "divergent vs price" : cvd > 0 ? "buy-pressure" : cvd < 0 ? "sell-pressure" : "flat", direction: cvdDivergence ? "strengthening" : "neutral" },
  ];

  const divergences = findDivergences(ohlcv);

  const tiers: Array<{ lev: number; density: number }> = [
    { lev: 5, density: 0.25 },
    { lev: 10, density: 0.45 },
    { lev: 25, density: 0.7 },
    { lev: 50, density: 0.55 },
    { lev: 100, density: 0.35 },
  ];
  const liquidations = currentPrice > 0
    ? tiers.flatMap((t) => [
      { price: currentPrice * (1 + 1 / t.lev), density: t.density, leverage: t.lev },
      { price: currentPrice * (1 - 1 / t.lev), density: t.density, leverage: t.lev },
    ])
    : [];

  let crossPair: Array<{ pair: string; zScore: number; signal: string }> | undefined;
  try {
    // Cached wrapper instead of computeCrossPairZScores() directly: the
    // result is universe-wide, so every /api/levels cache miss was paying
    // for 3× 90-day daily candle fetches on a hot path. The cache key is
    // a single global slot; 60 s TTL keeps freshness in line with the
    // /api/regime cadence.
    const xpResult = await getCachedCrossPair();
    crossPair = xpResult.value.map((x) => ({ pair: x.pair, zScore: x.zScore, signal: x.signal }));
  } catch { crossPair = []; }

  const ai = await synthesize({
    symbol, interval, currentPrice,
    regime: { hurst: h, regimeLabel: reg.label, garchRegime: garchLabel },
    zones,
    signals: signals.map((s) => ({ name: s.name, value: s.value, label: s.label })),
    crossPair,
  });

  const tEnd = performance.now();
  const collector = currentTimingCollector();
  if (collector) {
    collector.upstreamMs = Math.round(upstreamBranchMs);
    collector.htfPeerMs = Math.round(htfPeerBranchMs);
    collector.engineMs = Math.round(tEnd - tUpstream);
    collector.computeMs = Math.round(tEnd - tStart);
    collector.peers = peers.length;
    collector.higherTf = higherTf;
  }
  return {
    symbol,
    interval,
    currentPrice,
    regime,
    levels: rawLevels.map((l) => ({
      price: l.price, method: l.method, kind: l.kind,
      strength: l.strength, validated: l.validated,
      bounceRate: l.bounceRate, pValue: l.pValue, touches: l.touches,
      lastTouchAge: Number.isFinite(l.lastTouchAge) ? l.lastTouchAge : null,
      isStale: l.isStale,
    })),
    zones,
    signals,
    divergences,
    kde: kdePoints,
    liquidations,
    ai,
    generatedAt: Date.now(),
    unsupported: false as const,
    // Tag the response with the source that produced the bars so the
    // chart toolbar can show "Toobit" when HL is rate-limiting and we
    // fell back. The HTF/peer fetches may have used a different source
    // internally — only the *primary* symbol's source is surfaced
    // because that's what the chart's price action represents.
    dataSource,
  };
}
