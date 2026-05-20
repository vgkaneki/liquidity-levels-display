import { LiquidityHeatmap, useGetCandles, useGetLiquidations } from "@workspace/api-client-react";
import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useChartSettings, publishLiquidityLevels, paletteColorFor, overlayLineDash, type IndicatorInstance, type OverlayLineStyle, type OverlayColorPalette } from "@/lib/chartSettings";
import { publishChartAxis, decimalsForPrice } from "@/lib/chartAxisBus";
import { useStructuralLevels, prefetchStructuralLevels, structuralZoneColor } from "@/lib/structuralLevels";
import { useRegistryLevels } from "@/hooks/useRegistryLevels";
import { useAnalyticsOverlays, type AnalyticsOverlaysData, type MagnetCluster } from "@/hooks/useAnalyticsOverlays";
import { useLiquidationClusters, type LiquidationCluster } from "@/hooks/useLiquidationClusters";
import { classifyLines, tierColor } from "@/lib/levelTierAdapter";
import { runChartPlugins } from "@/lib/chartPlugins";
import { apiUrl } from "@/lib/api";
import { normalizeSymbolKey, normalizeIntervalKey } from "@/datafeed/normalize";
import { getDatafeed, type Resolution } from "@/datafeed";
import { DATAFEED_SHADOW_ENABLED, shadowCompare } from "@/datafeed/shadow";
import { IndicatorLegend } from "./IndicatorLegend";
import { IndicatorSettingsDialog } from "./IndicatorSettingsDialog";
import {
  addDrawing,
  setActiveDrawingTool,
  useDrawingState,
  type ChartDrawing,
  type DrawingPoint,
  type DrawingToolId,
} from "@/lib/drawingStore";
import { candleWatchdogDelayMs, displayCandlesWithFallback, rememberLastGoodCandles } from "@/lib/chartCandleFallback";
import { chartOverlaySettleDelayMs, isChartReadyForOverlays } from "@/lib/chartReadiness";

// Single canonical source of truth for every supported chart interval.
// `Interval` is derived from this array so any consumer that needs to
// validate an untrusted string (e.g. a stale localStorage value or a
// query-string parameter) can `INTERVALS.includes(s as Interval)`
// without risk of drifting from the type definition.
export const INTERVALS = [
  "1m", "3m", "5m", "15m", "30m",
  "1H", "2H", "4H", "6H", "12H",
  "1D", "3D", "1W", "1M",
] as const;
export type Interval = typeof INTERVALS[number];

/**
 * A single zone the user wants pre-highlighted on the chart, typically
 * carried in via a query string from the level-touch scanner so the user
 * lands on the matched level instead of a generic chart.
 */
export interface HeatmapHighlight {
  priceLow: number;
  priceHigh: number;
  midPrice: number;
  source?: string;
  kind?: string;
  timeframe?: string;
}

interface HeatmapChartProps {
  data: LiquidityHeatmap | null;
  isLoading: boolean;
  symbol?: string;
  interval?: Interval;
  /**
   * When this number changes, the chart sets its visible window to that
   * many bars (anchored to the right edge). Used by the bottom RangeBar
   * to implement TradingView-style 1D / 5D / 1M / All quick zoom.
   */
  requestVisibleBars?: number;
  /**
   * Pre-highlighted zone to glow on top of the heatmap. Cleared by the
   * parent on symbol change or via {@link HeatmapChartProps.onDismissHighlight}
   * once the user interacts with the chart.
   */
  highlight?: HeatmapHighlight | null;
  /**
   * Called the first time the user pans/zooms/clicks the chart while a
   * highlight is active, so the parent can drop it.
   */
  onDismissHighlight?: () => void;
  /**
   * Fired when the user double-clicks on a persistent level line on the
   * chart. The parent typically opens the journal popover anchored to
   * this level. The id is derived from the level's price (stable per
   * symbol), so it matches the ids the JournalPopover picker emits.
   */
  onLevelClick?: (level: { id: string; price: number; side: "bid" | "ask"; tier: number }) => void;
  /**
   * When true the chart renders in dense-grid mode: level/journal click
   * handlers are suppressed so parent wrappers (e.g. Grid tile) can
   * receive the click instead, and visual overlays (axis labels,
   * indicator legend, crosshair labels) render at reduced density.
   */
  compact?: boolean;
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  // Real volume from the upstream exchange (USD-quoted notional). Optional
  // because legacy in-memory bars built from live mark-price ticks have
  // no upstream volume yet — those render as 0 in volume-derived series.
  volume?: number;
}

function prepareCanvasFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): void {
  const targetWidth = Math.max(1, Math.floor(width * dpr));
  const targetHeight = Math.max(1, Math.floor(height * dpr));

  // Changing canvas.width/height clears and reallocates the backing store.
  // Only do that on real resize/DPR changes; live market ticks then reuse
  // the same allocation and simply clear the current frame.
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
  if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
}

interface BacktestResult {
  touches: number;
  reversals: number;
  winRate: number;
  avgBounce: number;
  reliability: number;
}

interface LiquidityLine {
  price: number;
  strength: number;
  isBid: boolean;
  tier: "elite" | "strong" | "normal";
  touchCount: number;
  winRate: number;
  reliability: number;
}

const INTERVAL_MS: Record<string, number> = {
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
const MAX_CANDLES = 200;

// ============ COLOR HELPERS ============
function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith("rgba(") || color.startsWith("rgb(")) {
    // Replace alpha if rgba, else convert rgb→rgba
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1]!.split(",").map((s) => s.trim());
      const [r, g, b] = parts;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  let hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ============ INDICATOR COMPUTATIONS ============
function computeSMA(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= length) sum -= closes[i - length]!;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function computeEMA(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0 || values.length < length) return out;
  const k = 2 / (length + 1);
  // Seed with SMA of first `length` values
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i]!;
  let ema = sum / length;
  out[length - 1] = ema;
  for (let i = length; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeBollingerBands(closes: number[], length: number, mult: number): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = computeSMA(closes, length);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = length - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const diff = closes[j]! - mid[i]!;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / length);
    upper[i] = mid[i]! + mult * std;
    lower[i] = mid[i]! - mult * std;
  }
  return { mid, upper, lower };
}

function rsiPoint(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeRSI(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < length + 1 || length <= 0) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (!Number.isFinite(ch)) return out;
    if (ch > 0) avgGain += ch; else if (ch < 0) avgLoss -= ch;
  }
  avgGain /= length;
  avgLoss /= length;
  out[length] = rsiPoint(avgGain, avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (!Number.isFinite(ch)) continue;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = rsiPoint(avgGain, avgLoss);
  }
  return out;
}

function computeMACD(closes: number[], fast: number, slow: number, signalLen: number): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macd: (number | null)[] = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i]! - emaSlow[i]!) : null
  );
  // Compute signal EMA only over valid (non-null) MACD values, then re-align
  const validMacd: number[] = [];
  const validIdx: number[] = [];
  for (let i = 0; i < macd.length; i++) {
    if (macd[i] != null) { validMacd.push(macd[i]!); validIdx.push(i); }
  }
  const validSignal = computeEMA(validMacd, signalLen);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  for (let j = 0; j < validIdx.length; j++) signal[validIdx[j]!] = validSignal[j];
  const hist: (number | null)[] = macd.map((m, i) => (m != null && signal[i] != null ? m - signal[i]! : null));
  return { macd, signal, hist };
}

// Real-only: returns the upstream-reported volume for a candle, or 0 if
// the candle is from the in-memory live-tick store (no exchange volume
// available yet). Volume-dependent indicators (CVD, volume bars) tolerate
// 0-volume bars by rendering them at zero height.
function candleVolume(c: Candle): number {
  return c.volume ?? 0;
}

// ============ NEW: Tick-rule volume delta (industry-standard fallback) ============
// Returns approximated buy/sell volume per candle. Green candle (close>open) → all buy,
// red → all sell, doji → split 50/50. This is the standard approximation when tick-level
// trade data is unavailable.
function tickRuleDelta(c: Candle, vol: number): { buy: number; sell: number } {
  if (c.close > c.open) return { buy: vol, sell: 0 };
  if (c.close < c.open) return { buy: 0, sell: vol };
  return { buy: vol / 2, sell: vol / 2 };
}

function computeCVD(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  let cum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const vol = candleVolume(c);
    const { buy, sell } = tickRuleDelta(c, vol);
    cum += buy - sell;
    out[i] = cum;
  }
  return out;
}

// ============ NEW: Swing detection for Fibonacci ============
function findSwingHighLow(candles: Candle[], lookback: number): { hi: number; lo: number; hiIdx: number; loIdx: number } | null {
  if (candles.length === 0) return null;
  const start = Math.max(0, candles.length - lookback);
  let hi = -Infinity, lo = Infinity, hiIdx = start, loIdx = start;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.high > hi) { hi = c.high; hiIdx = i; }
    if (c.low < lo) { lo = c.low; loIdx = i; }
  }
  if (!isFinite(hi) || !isFinite(lo)) return null;
  return { hi, lo, hiIdx, loIdx };
}

// Parse a Fibonacci sequence string like "0|1|2|3|5|8|13|21|34|55|89"
function parseFibLevels(spec: string): number[] {
  return spec
    .split(/[|,]/)
    .map((s) => parseFloat(s.trim()))
    .filter((n) => isFinite(n));
}

// Normalize a Fib sequence to [0,1] proportions of the swing range.
function fibSequenceToProportions(seq: number[]): number[] {
  const clean = seq.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) return [];
  const max = Math.max(...clean);
  if (max <= 0) return clean.map(() => 0);
  return clean.map((v) => v / max);
}

// ============ NEW: Liquidation zone simulation ============
// For each candle, compute likely liquidation prices at the given leverages.
// Long liqs sit BELOW the entry (low) by ~(1/lev)*buffer.
// Short liqs sit ABOVE the entry (high) by ~(1/lev)*buffer.
// We bin them into horizontal price slots and return density per slot.
interface LiqBin { price: number; longDensity: number; shortDensity: number; }

function computeLiquidationBins(
  candles: Candle[],
  leverages: number[],
  bufferPct: number,
  bins: number,
  loPrice: number,
  hiPrice: number
): LiqBin[] {
  if (bins <= 0 || hiPrice <= loPrice || !Number.isFinite(loPrice) || !Number.isFinite(hiPrice)) return [];
  leverages = leverages.filter((lev) => Number.isFinite(lev) && lev > 0);
  if (leverages.length === 0) return [];
  const out: LiqBin[] = new Array(bins).fill(null).map((_, i) => ({
    price: loPrice + ((i + 0.5) * (hiPrice - loPrice)) / bins,
    longDensity: 0,
    shortDensity: 0,
  }));
  const slot = (p: number) => {
    const t = (p - loPrice) / (hiPrice - loPrice);
    if (t < 0 || t > 1) return -1;
    return Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (!Number.isFinite(c.high) || !Number.isFinite(c.low) || c.high <= 0 || c.low <= 0) continue;
    // Recency weight: more recent candles contribute more
    const w = 1 + i / Math.max(1, candles.length);
    for (const lev of leverages) {
      if (lev <= 0) continue;
      const dist = (1 / lev) * (1 + bufferPct);
      // Long liquidation (entry near high, liq below)
      const longLiq = c.high * (1 - dist);
      const ls = slot(longLiq);
      if (ls >= 0) out[ls]!.longDensity += w;
      // Short liquidation (entry near low, liq above)
      const shortLiq = c.low * (1 + dist);
      const ss = slot(shortLiq);
      if (ss >= 0) out[ss]!.shortDensity += w;
    }
  }
  return out;
}

interface CandleStore {
  candles: Candle[];
  lastCandleStart: number;
  intervalMs: number;
  // Identity reference to the seed array we last hydrated from. When the
  // API delivers a fresh seed (new array reference on each refetch) we
  // re-seed the store so the chart never drifts from the real bars.
  seedRef: Candle[] | null;
}
const candleStores: Record<string, CandleStore> = {};

/**
 * Real-only candle store. Seeded with the upstream candles (HL → Toobit →
 * OKX) and updated in place by live mark-price ticks so the rightmost
 * forming bar reflects the latest price. Re-seeds whenever the API
 * delivers a fresh array (identity check) so reconciliation with the
 * server is automatic and lossless.
 */
function updateCandleStore(
  symbol: string,
  markPrice: number,
  intervalMs: number,
  seedCandles: Candle[],
): Candle[] {
  const now = Date.now();
  const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
  const storeKey = `${symbol}:${intervalMs}`;

  let store = candleStores[storeKey];
  if (!store || store.seedRef !== seedCandles) {
    const last = seedCandles[seedCandles.length - 1];
    store = candleStores[storeKey] = {
      candles: seedCandles.map((c) => ({ ...c })),
      intervalMs,
      lastCandleStart: last
        ? Math.floor(last.timestamp / intervalMs) * intervalMs
        : currentCandleStart,
      seedRef: seedCandles,
    };
  }

  if (currentCandleStart > store.lastCandleStart) {
    const lastCandle = store.candles[store.candles.length - 1];
    store.candles.push({
      timestamp: currentCandleStart,
      open: lastCandle ? lastCandle.close : markPrice,
      high: markPrice, low: markPrice, close: markPrice,
    });
    if (store.candles.length > MAX_CANDLES) store.candles.shift();
    store.lastCandleStart = currentCandleStart;
  }

  const last = store.candles[store.candles.length - 1];
  if (last && Number.isFinite(markPrice) && markPrice > 0) {
    last.close = markPrice;
    last.high = Math.max(last.high, markPrice);
    last.low = Math.min(last.low, markPrice);
  }
  return store.candles;
}

/**
 * Wilder-style ATR over the candle series, normalized as a fraction of mark
 * price. Used to scale the reversal bounce threshold so a "real" bounce on a
 * quiet day is the same statistical event as on a volatile day.
 */
function computeAtrFraction(candles: Candle[], markPrice: number): number {
  const n = candles.length;
  if (n < 2 || markPrice <= 0 || !Number.isFinite(markPrice)) return 0;
  const period = Math.min(14, n - 1);
  let sum = 0;
  let count = 0;
  for (let i = n - period; i < n; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    if (!Number.isFinite(tr) || tr < 0) continue;
    sum += tr;
    count++;
  }
  if (count === 0) return 0;
  const atr = sum / count;
  return atr / markPrice;
}

function backtestLevel(
  price: number,
  candles: Candle[],
  tolerance: number,
  atrFrac: number,
): BacktestResult {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tolerance) || tolerance < 0) {
    return { touches: 0, reversals: 0, winRate: 0, avgBounce: 0, reliability: 0 };
  }
  const totalCandles = candles.length;
  let touches = 0;
  let reversals = 0;
  let totalBounce = 0;
  const DECAY_LAMBDA = 3.0;

  // Volatility-aware reversal scoring. The original 30bp/3-bar values were
  // calibrated for a single quiet regime: in high-vol sessions a 30bp move
  // is noise, and 3 bars (45 minutes on 15m) often isn't long enough for a
  // structural reversal to express. Scale both with realized volatility so
  // we measure the same statistical event regardless of regime.
  const lookAheadBars = atrFrac > 0.012 ? 12 : atrFrac > 0.006 ? 10 : 8;
  const minBounce = Math.max(0.003, 0.6 * atrFrac);
  // Rebase the bounce normalizer to ~3x ATR so "great bounces" (full credit)
  // grow with volatility rather than being capped at the old static 1.5%.
  const bounceCap = Math.max(0.015, 3 * atrFrac);

  let recencyWeightSum = 0;
  let recencyReversalSum = 0;

  for (let i = 0; i < totalCandles; i++) {
    const c = candles[i]!;

    // Sweep-aware touch detection. Originally a touch only registered when
    // the wick *extreme* fell inside the band — which silently dropped every
    // sweep-and-reclaim, the highest-quality reversal pattern. New rule: a
    // touch from below registers when the candle *approached* from below
    // (open strictly below the band), its high reached the band, AND its
    // close came back below the band's top. Symmetric for touches from
    // above. The "strictly outside the band" gate on `open` makes the two
    // flags mutually exclusive: a candle opening inside the band is treated
    // as a transition, not an approach, and contributes no touch — which
    // prevents the reversal scorer from evaluating both directions on one
    // candle and inflating the win rate.
    const upperBand = price + tolerance;
    const lowerBand = price - tolerance;

    const openedStrictlyBelow = c.open < lowerBand;
    const rangeReachedFromBelow = c.high >= lowerBand;
    const closedBackBelow = c.close <= upperBand;
    const touchedFromBelow = openedStrictlyBelow && rangeReachedFromBelow && closedBackBelow;

    const openedStrictlyAbove = c.open > upperBand;
    const rangeReachedFromAbove = c.low <= upperBand;
    const closedBackAbove = c.close >= lowerBand;
    const touchedFromAbove = openedStrictlyAbove && rangeReachedFromAbove && closedBackAbove;

    if (!touchedFromBelow && !touchedFromAbove) continue;
    touches++;

    const recencyFraction = i / Math.max(1, totalCandles - 1);
    const recencyWeight = Math.exp(DECAY_LAMBDA * (recencyFraction - 1));

    recencyWeightSum += recencyWeight;

    const lookAhead = Math.min(i + lookAheadBars, totalCandles - 1);
    let maxBounce = 0;

    for (let j = i + 1; j <= lookAhead; j++) {
      const fc = candles[j]!;
      if (touchedFromBelow) {
        // Bounce away from resistance = price falling below the level.
        const bounceAway = (price - fc.low) / price;
        maxBounce = Math.max(maxBounce, bounceAway);
      }
      if (touchedFromAbove) {
        // Bounce away from support = price rising above the level.
        const bounceAway = (fc.high - price) / price;
        maxBounce = Math.max(maxBounce, bounceAway);
      }
    }

    if (maxBounce >= minBounce) {
      reversals++;
      totalBounce += maxBounce;
      recencyReversalSum += recencyWeight;
    }
  }

  const winRate = touches > 0 ? reversals / touches : 0;
  const avgBounce = reversals > 0 ? totalBounce / reversals : 0;
  const recencyWeight = recencyWeightSum > 0 ? recencyReversalSum / recencyWeightSum : 0;

  const normalizedBounce = Math.min(1, avgBounce / bounceCap);
  const reliability = touches >= 2
    ? winRate * normalizedBounce * recencyWeight
    : 0;

  return { touches, reversals, winRate, avgBounce, reliability };
}

interface ConfluenceMap {
  swingPoints: number[];
  rejectionWicks: number[];
  trappedTraderLevels: number[];
  sessionAnchors: number[];
  impulseMidpoints: number[];
  momentumStalls: number[];
  compressionEdges: number[];
  failedBreakouts: number[];
  /**
   * Real liquidation clusters: aggregated USD value at each price band
   * (~0.2% wide). Candidate levels that overlap a high-magnitude cluster
   * get a confluence boost — see W_LIQ_CLUSTER in computeConfluence.
   * `maxUsd` is the per-symbol normalizer so the boost is regime-aware
   * (a $1M cluster is a big deal on a small-cap, noise on BTC).
   */
  liqClusters: { price: number; usdValue: number }[];
  liqClusterMaxUsd: number;
}

interface RawLiquidation {
  price: number;
  usdValue: number;
}

function buildLiqClusters(
  liqs: RawLiquidation[],
  markPrice: number,
): { clusters: { price: number; usdValue: number }[]; maxUsd: number } {
  if (!liqs.length || markPrice <= 0) return { clusters: [], maxUsd: 0 };
  // Bucket width: ~0.2% of mark — wide enough that a flurry of close-by
  // liquidations aggregates into one cluster, narrow enough that distinct
  // squeeze zones don't merge.
  const bucketSize = markPrice * 0.002;
  const bins = new Map<number, { sum: number; weighted: number }>();
  for (const l of liqs) {
    if (!Number.isFinite(l.price) || !Number.isFinite(l.usdValue)) continue;
    if (l.usdValue <= 0) continue;
    const bucket = Math.round(l.price / bucketSize);
    const cur = bins.get(bucket) ?? { sum: 0, weighted: 0 };
    cur.sum += l.usdValue;
    cur.weighted += l.usdValue * l.price;
    bins.set(bucket, cur);
  }
  const clusters: { price: number; usdValue: number }[] = [];
  let maxUsd = 0;
  for (const v of bins.values()) {
    if (v.sum <= 0) continue;
    clusters.push({ price: v.weighted / v.sum, usdValue: v.sum });
    if (v.sum > maxUsd) maxUsd = v.sum;
  }
  return { clusters, maxUsd };
}

function buildConfluenceMap(
  candles: Candle[],
  markPrice: number,
  liqClusters: { price: number; usdValue: number }[] = [],
  liqClusterMaxUsd: number = 0,
): ConfluenceMap {
  const len = candles.length;
  const swingPoints: number[] = [];
  const rejectionWicks: number[] = [];
  const trappedTraderLevels: number[] = [];
  const sessionAnchors: number[] = [];
  const impulseMidpoints: number[] = [];
  const momentumStalls: number[] = [];
  const compressionEdges: number[] = [];
  const failedBreakouts: number[] = [];

  const typedSwings: { price: number; idx: number; type: "high" | "low" }[] = [];
  const SWING_LOOKBACK = 5;
  for (let i = SWING_LOOKBACK; i < len - SWING_LOOKBACK; i++) {
    const c = candles[i]!;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= SWING_LOOKBACK; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isSwingHigh = false;
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isSwingLow = false;
    }
    if (isSwingHigh) {
      swingPoints.push(c.high);
      typedSwings.push({ price: c.high, idx: i, type: "high" });
    }
    if (isSwingLow) {
      swingPoints.push(c.low);
      typedSwings.push({ price: c.low, idx: i, type: "low" });
    }
  }

  for (let i = 0; i < len; i++) {
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    const fullRange = c.high - c.low;
    if (fullRange < markPrice * 0.001) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (upperWick > body * 1.5 && upperWick > fullRange * 0.4) {
      rejectionWicks.push(c.high);
    }
    if (lowerWick > body * 1.5 && lowerWick > fullRange * 0.4) {
      rejectionWicks.push(c.low);
    }
  }

  for (let i = 0; i < len; i++) {
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    if (body > markPrice * 0.003) {
      const origin = c.close > c.open ? c.open : c.close;
      trappedTraderLevels.push(origin);
      impulseMidpoints.push((c.high + c.low) / 2);
    }
  }

  const SESSION_SIZE = 6;
  for (let i = 0; i < len; i += SESSION_SIZE) {
    const end = Math.min(i + SESSION_SIZE, len);
    let sHigh = -Infinity, sLow = Infinity;
    const sOpen = candles[i]!.open;
    const sClose = candles[end - 1]!.close;
    for (let j = i; j < end; j++) {
      if (candles[j]!.high > sHigh) sHigh = candles[j]!.high;
      if (candles[j]!.low < sLow) sLow = candles[j]!.low;
    }
    sessionAnchors.push(sHigh, sLow, sOpen, sClose);
  }

  let streak = 0;
  let lastDir = 0;
  for (let i = 1; i < len; i++) {
    const dir = candles[i]!.close >= candles[i]!.open ? 1 : -1;
    if (dir === lastDir) {
      streak++;
    } else {
      if (streak >= 3) {
        const prev = candles[i - 1]!;
        momentumStalls.push(lastDir > 0 ? prev.high : prev.low);
      }
      streak = 1;
      lastDir = dir;
    }
  }
  if (streak >= 3 && len > 0) {
    const last = candles[len - 1]!;
    momentumStalls.push(lastDir > 0 ? last.high : last.low);
  }

  const COMP_WINDOW = 8;
  for (let i = 0; i <= len - COMP_WINDOW; i++) {
    let wHigh = -Infinity, wLow = Infinity;
    for (let j = i; j < i + COMP_WINDOW; j++) {
      if (candles[j]!.high > wHigh) wHigh = candles[j]!.high;
      if (candles[j]!.low < wLow) wLow = candles[j]!.low;
    }
    const range = wHigh - wLow;
    if (range < markPrice * 0.012 && range > 0) {
      compressionEdges.push(wHigh, wLow);
    }
  }

  for (const sw of typedSwings) {
    let broken = false;
    for (let i = sw.idx + 1; i < len; i++) {
      const c = candles[i]!;
      if (!broken) {
        if (sw.type === "high" && c.close > sw.price * 1.002) broken = true;
        if (sw.type === "low" && c.close < sw.price * 0.998) broken = true;
      } else {
        if (sw.type === "high" && c.close < sw.price * 0.999) {
          failedBreakouts.push(sw.price);
          break;
        }
        if (sw.type === "low" && c.close > sw.price * 1.001) {
          failedBreakouts.push(sw.price);
          break;
        }
      }
    }
  }

  return {
    swingPoints, rejectionWicks, trappedTraderLevels,
    sessionAnchors, impulseMidpoints, momentumStalls,
    compressionEdges, failedBreakouts,
    liqClusters, liqClusterMaxUsd,
  };
}

function computeConfluence(price: number, cmap: ConfluenceMap, tolerance: number): number {
  let score = 0;
  // Weights re-balanced to make room for the real liquidation-cluster signal
  // without inflating total score above 1.0. The liquidation contribution is
  // intentionally meaningful (10%) — it's the only "evidence of forced flow"
  // input the scorer has, so when it fires it should move the needle.
  const W_SWING = 0.20;
  const W_TRAPPED = 0.18;
  const W_SESSION = 0.13;
  const W_REJECTION = 0.11;
  const W_FAILED_BO = 0.10;
  const W_LIQ_CLUSTER = 0.10;
  const W_IMPULSE_MID = 0.07;
  const W_MOMENTUM = 0.06;
  const W_COMPRESSION = 0.05;

  const near = (arr: number[], tol: number) => {
    let best = 0;
    for (const p of arr) {
      const dist = Math.abs(p - price);
      if (dist < tol) {
        const proximity = 1 - dist / tol;
        best = Math.max(best, proximity);
      }
    }
    return best;
  };

  const count = (arr: number[], tol: number) => {
    let n = 0;
    for (const p of arr) {
      if (Math.abs(p - price) < tol) n++;
    }
    return n;
  };

  const swingHit = near(cmap.swingPoints, tolerance * 1.5);
  const swingCount = Math.min(3, count(cmap.swingPoints, tolerance * 1.5));
  score += W_SWING * swingHit * (0.5 + 0.5 * swingCount / 3);

  const trappedHit = near(cmap.trappedTraderLevels, tolerance * 2);
  score += W_TRAPPED * trappedHit;

  const sessionHit = near(cmap.sessionAnchors, tolerance * 1.2);
  const sessionCount = Math.min(4, count(cmap.sessionAnchors, tolerance * 1.2));
  score += W_SESSION * sessionHit * (0.4 + 0.6 * sessionCount / 4);

  score += W_REJECTION * near(cmap.rejectionWicks, tolerance * 1.3);

  const fbHit = near(cmap.failedBreakouts, tolerance * 1.5);
  score += W_FAILED_BO * fbHit;

  score += W_IMPULSE_MID * near(cmap.impulseMidpoints, tolerance * 2);

  score += W_MOMENTUM * near(cmap.momentumStalls, tolerance * 1.5);

  const compHit = near(cmap.compressionEdges, tolerance * 1.2);
  const compCount = Math.min(3, count(cmap.compressionEdges, tolerance * 1.2));
  score += W_COMPRESSION * compHit * (0.3 + 0.7 * compCount / 3);

  // Real liquidation-cluster confluence. Walk the clusters and pick the
  // single best contribution: proximity (closer = higher) × magnitude
  // (USD value normalized against the symbol's max cluster, so a $500k
  // pile on PEPE is treated as significant the same way a $50M pile on
  // BTC would be). Tolerance is a touch wider than swing/session because
  // forced-flow zones are inherently fuzzier than discrete price points.
  if (cmap.liqClusters.length > 0 && cmap.liqClusterMaxUsd > 0) {
    const liqTol = tolerance * 2;
    let best = 0;
    for (const c of cmap.liqClusters) {
      const dist = Math.abs(c.price - price);
      if (dist >= liqTol) continue;
      const proximity = 1 - dist / liqTol;
      const magnitude = Math.min(1, c.usdValue / cmap.liqClusterMaxUsd);
      // sqrt-shape on magnitude so even mid-tier clusters contribute, but
      // the very biggest still dominate at the top end.
      const contribution = proximity * Math.sqrt(magnitude);
      if (contribution > best) best = contribution;
    }
    score += W_LIQ_CLUSTER * best;
  }

  return Math.min(1, score);
}

function extractLiquidityLines(
  data: LiquidityHeatmap,
  priceMin: number,
  priceMax: number,
  markPrice: number,
  candles: Candle[],
  liquidations: RawLiquidation[] = [],
): LiquidityLine[] {
  if (!data.levels?.length) return [];

  const visible = data.levels.filter(
    (l) => l.price >= priceMin && l.price <= priceMax
  );
  if (!visible.length) return [];

  const scored = visible.map((l) => ({
    level: l,
    score: l.compositeScore > 0 ? l.compositeScore : l.heatScore,
  }));

  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore === 0) return [];

  // Tighter tolerance (0.12% instead of 0.2%) — touches and confluence hits
  // must be much closer to the level to count, producing more accurate scores.
  const tolerance = markPrice * 0.0012;
  const { clusters, maxUsd } = buildLiqClusters(liquidations, markPrice);
  const cmap = buildConfluenceMap(candles, markPrice, clusters, maxUsd);
  const atrFrac = computeAtrFraction(candles, markPrice);

  const candidates = scored
    // Raised score floor (5% -> 25% of max) so only meaningful candidates
    // make it through — kills the long tail of weak/noise levels.
    .filter((s) => s.score > maxScore * 0.25)
    .map((s) => {
      const strength = s.score / maxScore;
      const bt = backtestLevel(s.level.price, candles, tolerance, atrFrac);
      const confluence = computeConfluence(s.level.price, cmap, tolerance);
      // Evidence-dominated blend. Orderbook size is a *prediction* (MMs
      // parked size here, so price *might* react); reliability is
      // *evidence* (price *did* react here, repeatedly). With the touch
      // detector now capturing sweeps and the bounce threshold scaled to
      // realized volatility, reliability is honest enough to lead the
      // ranking. Was 0.55 / 0.25 / 0.20.
      const finalStrength = Math.min(
        1,
        strength * 0.30 + bt.reliability * 0.50 + confluence * 0.20
      );
      return {
        price: s.level.price,
        strength: finalStrength,
        isBid: s.level.price < markPrice,
        tier: "normal" as "elite" | "strong" | "normal",
        touchCount: bt.touches,
        winRate: bt.winRate,
        reliability: bt.reliability,
      };
    })
    .sort((a, b) => {
      // Final tiebreaker still leans on reliability so two candidates with
      // identical blended strength rank by historical evidence first.
      const aRank = a.strength + a.reliability * 0.25;
      const bRank = b.strength + b.reliability * 0.25;
      return bRank - aRank;
    });

  // Enforce minimum spacing between accepted levels: walking strongest-first,
  // skip any candidate that sits within 0.4% of an already-accepted level.
  // This guarantees lines aren't visually stacked on top of each other and
  // each surviving line represents a distinct major zone.
  const minSpacing = markPrice * 0.004;
  const lines: typeof candidates = [];
  for (const c of candidates) {
    let tooClose = false;
    for (const accepted of lines) {
      if (Math.abs(accepted.price - c.price) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) lines.push(c);
  }

  for (let i = 0; i < lines.length; i++) {
    if (i < 3) {
      lines[i].tier = "elite";
    } else if (i < 7) {
      lines[i].tier = "strong";
    }
  }

  return lines;
}

interface PersistentLevel {
  price: number;
  strength: number;
  smoothedStrength: number;
  isBid: boolean;
  tier: "elite" | "strong" | "normal";
  tierStableUntil: number;
  touchCount: number;
  winRate: number;
  reliability: number;
  peakStrength: number;
  firstSeen: number;
  lastConfirmed: number;
}

const levelRegistries: Record<string, PersistentLevel[]> = {};
// 0.0015 = 0.15% of mark price. At BTC $77k that's ~$115 minimum gap between
// adjacent levels — prevents the "thicket of lines on top of each other" bug.
const MERGE_TOLERANCE_FACTOR = 0.0015;
// Final visual consolidation pass uses a wider tolerance still, so any two
// levels that survived merge but ended up < ~0.4% apart get folded together.
const VISUAL_CONSOLIDATE_FACTOR = 0.0022;
const REMOVAL_DISTANCE = 0.08;
// Chart-only fit guard: strong/elite levels can influence the visible price
// scale only when they sit reasonably close to the currently visible candle
// window. This preserves confluence near price without letting far-away
// levels vertically flatten the chart.
const OVERLAY_FIT_RANGE_MULTIPLIER = 0.18;
const OVERLAY_FIT_PAD_MULTIPLIER = 0.025;
const OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER = 0.18;
const MAX_LEVELS_PER_SYMBOL = 60;
const MAX_SYMBOLS_IN_REGISTRY = 20;
const STALE_TTL_MS = 300_000;
const DECAY_RATE = 0.015;
const MIN_STRENGTH_FLOOR = 0.08;
const PRICE_TICK_FACTOR = 0.0002;
const STRENGTH_EMA_OLD = 0.85;
const STRENGTH_EMA_NEW = 0.15;
const RELIABILITY_EMA_OLD = 0.85;
const RELIABILITY_EMA_NEW = 0.15;
const TIER_HOLD_MS = 60_000;
const TIER_DROP_MARGIN = 0.05;

function snapPriceToTick(price: number, markPrice: number): number {
  const tick = Math.max(markPrice * PRICE_TICK_FACTOR, Number.EPSILON);
  return Math.round(price / tick) * tick;
}


function evictOldestSymbols(): void {
  const keys = Object.keys(levelRegistries);
  if (keys.length <= MAX_SYMBOLS_IN_REGISTRY) return;
  const entries = keys.map((k) => {
    const levels = levelRegistries[k];
    const newest = levels.reduce(
      (m, l) => Math.max(m, l.lastConfirmed),
      0
    );
    return { key: k, newest };
  });
  entries.sort((a, b) => a.newest - b.newest);
  const toRemove = entries.length - MAX_SYMBOLS_IN_REGISTRY;
  for (let i = 0; i < toRemove; i++) {
    delete levelRegistries[entries[i].key];
  }
}

function mergeAndPersistLevels(
  rawSymbol: string,
  freshLines: LiquidityLine[],
  markPrice: number,
  candles: Candle[]
): LiquidityLine[] {
  const symbol = normalizeSymbolKey(rawSymbol);
  const now = Date.now();
  const mergeTol = markPrice * MERGE_TOLERANCE_FACTOR;

  if (!levelRegistries[symbol]) {
    evictOldestSymbols();
    levelRegistries[symbol] = freshLines.map((l) => ({
      ...l,
      price: snapPriceToTick(l.price, markPrice),
      smoothedStrength: l.strength,
      tierStableUntil: now + TIER_HOLD_MS,
      peakStrength: l.strength,
      firstSeen: now,
      lastConfirmed: now,
    }));
    return retieredCopy(levelRegistries[symbol], markPrice);
  }

  const registry = levelRegistries[symbol];
  const matchedIndices = new Set<number>();

  for (const fresh of freshLines) {
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < registry.length; i++) {
      if (matchedIndices.has(i)) continue;
      const dist = Math.abs(registry[i].price - fresh.price);
      if (dist < mergeTol && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const existing = registry[bestIdx];
      // Price is FROZEN — never recomputed. Only stats blend in slowly.
      existing.strength = existing.strength * STRENGTH_EMA_OLD + fresh.strength * STRENGTH_EMA_NEW;
      existing.smoothedStrength =
        existing.smoothedStrength * STRENGTH_EMA_OLD + fresh.strength * STRENGTH_EMA_NEW;
      existing.peakStrength = Math.max(existing.peakStrength, fresh.strength);
      existing.touchCount = Math.max(existing.touchCount, fresh.touchCount);
      // winRate keeps its original 0.3/0.7 blend — out of scope for this task.
      existing.winRate = existing.winRate * 0.3 + fresh.winRate * 0.7;
      existing.reliability =
        existing.reliability * RELIABILITY_EMA_OLD + fresh.reliability * RELIABILITY_EMA_NEW;
      existing.lastConfirmed = now;
      matchedIndices.add(bestIdx);
    } else {
      registry.push({
        ...fresh,
        price: snapPriceToTick(fresh.price, markPrice),
        smoothedStrength: fresh.strength,
        tierStableUntil: now + TIER_HOLD_MS,
        peakStrength: fresh.strength,
        firstSeen: now,
        lastConfirmed: now,
      });
    }
  }

  for (let i = 0; i < registry.length; i++) {
    if (!matchedIndices.has(i)) {
      const staleDuration = now - registry[i].lastConfirmed;
      if (staleDuration > 6000) {
        registry[i].strength = Math.max(
          MIN_STRENGTH_FLOOR,
          registry[i].strength * (1 - DECAY_RATE)
        );
        registry[i].smoothedStrength = Math.max(
          MIN_STRENGTH_FLOOR,
          registry[i].smoothedStrength * (1 - DECAY_RATE)
        );
        registry[i].reliability = Math.max(
          0,
          registry[i].reliability * (1 - DECAY_RATE * 0.5)
        );
      }
    }
  }

  const recentCloses = candles.slice(-5).map((c) => c.close);
  levelRegistries[symbol] = registry.filter((level) => {
    const distance = Math.abs(markPrice - level.price) / markPrice;
    if (distance > REMOVAL_DISTANCE) return false;

    const staleDuration = now - level.lastConfirmed;
    if (staleDuration > STALE_TTL_MS) return false;

    if (level.strength <= MIN_STRENGTH_FLOOR && staleDuration > 60000)
      return false;

    if (recentCloses.length >= 3) {
      const breakThreshold = markPrice * 0.003;
      const allAbove = recentCloses.every(
        (cl) => cl > level.price + breakThreshold
      );
      const allBelow = recentCloses.every(
        (cl) => cl < level.price - breakThreshold
      );

      if (allAbove || allBelow) {
        const age = now - level.firstSeen;
        if (age > 30000 && distance > 0.004) return false;
      }
    }

    return true;
  });

  if (levelRegistries[symbol].length > MAX_LEVELS_PER_SYMBOL) {
    levelRegistries[symbol].sort((a, b) => {
      const aRank = a.strength + a.reliability * 0.25;
      const bRank = b.strength + b.reliability * 0.25;
      return bRank - aRank;
    });
    levelRegistries[symbol] = levelRegistries[symbol].slice(
      0,
      MAX_LEVELS_PER_SYMBOL
    );
  }

  return retieredCopy(levelRegistries[symbol], markPrice);
}

function consolidateOverlaps(
  registry: PersistentLevel[],
  tol: number
): PersistentLevel[] {
  if (registry.length < 2) return registry;
  // Sort by price ascending, but track the "dominant" entry per overlap group
  // by strength so we keep the stronger level's price (no drift).
  const sorted = [...registry].sort((a, b) => a.price - b.price);
  const out: PersistentLevel[] = [];
  for (const lvl of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(lvl.price - last.price) <= tol) {
      // Keep the dominant entry's PRICE — never recompute it. Choose by
      // smoothedStrength with a hysteresis margin + age tiebreak so the kept
      // price doesn't flip frame-to-frame when scores are near-equal.
      const dominanceMargin = 0.05;
      const scoreDiff = lvl.smoothedStrength - last.smoothedStrength;
      const lvlIsDominant =
        scoreDiff > dominanceMargin ||
        (Math.abs(scoreDiff) <= dominanceMargin && lvl.firstSeen < last.firstSeen);
      if (lvlIsDominant) {
        last.price = lvl.price;
      }
      // Always carry forward the oldest firstSeen so age-based logic
      // (decay, break-removal age gate) reflects the cluster's true history.
      last.firstSeen = Math.min(last.firstSeen, lvl.firstSeen);
      // Combine stats — but never above 1.
      last.strength = Math.min(
        1,
        Math.max(last.strength, lvl.strength) +
          Math.min(last.strength, lvl.strength) * 0.15
      );
      last.smoothedStrength = Math.min(
        1,
        Math.max(last.smoothedStrength, lvl.smoothedStrength) +
          Math.min(last.smoothedStrength, lvl.smoothedStrength) * 0.15
      );
      last.peakStrength = Math.max(last.peakStrength, lvl.peakStrength);
      last.touchCount = Math.max(last.touchCount, lvl.touchCount);
      last.winRate = Math.max(last.winRate, lvl.winRate);
      last.reliability = Math.max(last.reliability, lvl.reliability);
      last.lastConfirmed = Math.max(last.lastConfirmed, lvl.lastConfirmed);
      last.tierStableUntil = Math.max(last.tierStableUntil, lvl.tierStableUntil);
    } else {
      out.push({ ...lvl });
    }
  }
  return out;
}

const ELITE_COUNT = 5;
const STRONG_COUNT = 14;

function tierForRank(rank: number): "elite" | "strong" | "normal" {
  return rank < ELITE_COUNT ? "elite" : rank < STRONG_COUNT ? "strong" : "normal";
}

function tierWeight(tier: "elite" | "strong" | "normal"): number {
  return tier === "elite" ? 2 : tier === "strong" ? 1 : 0;
}

function retieredCopy(
  levels: PersistentLevel[],
  markPrice: number
): LiquidityLine[] {
  // Rank by smoothed strength so single-tick noise can't reorder the list.
  const sorted = [...levels].sort((a, b) => {
    const aRank = a.smoothedStrength + a.reliability * 0.25;
    const bRank = b.smoothedStrength + b.reliability * 0.25;
    return bRank - aRank;
  });

  const now = Date.now();

  return sorted.map((l, i) => {
    const rankTier = tierForRank(i);

    // Tier hysteresis: a level may UPGRADE freely (strength is improving),
    // but DOWNGRADES only if either (a) its hold window has expired, or
    // (b) the next-tier line below it is meaningfully stronger.
    let finalTier: "elite" | "strong" | "normal" = rankTier;
    if (tierWeight(rankTier) < tierWeight(l.tier)) {
      const holdActive = now < l.tierStableUntil;
      // Strongest line in the tier we'd be dropping into (first entry there).
      // elite (0..ELITE_COUNT-1) -> strong starts at ELITE_COUNT
      // strong (ELITE_COUNT..STRONG_COUNT-1) -> normal starts at STRONG_COUNT
      const dropToRankIdx = l.tier === "elite" ? ELITE_COUNT : STRONG_COUNT;
      const competitor = sorted[dropToRankIdx];
      const competitorScore = competitor
        ? competitor.smoothedStrength + competitor.reliability * 0.25
        : 0;
      const ourScore = l.smoothedStrength + l.reliability * 0.25;
      const meaningfullyWeaker = ourScore + TIER_DROP_MARGIN < competitorScore;
      if (holdActive && !meaningfullyWeaker) {
        finalTier = l.tier; // hold previous tier
      }
    }

    // Refresh hold window only on hold or upgrade — not on accepted downgrades.
    const isUpgrade = tierWeight(finalTier) > tierWeight(l.tier);
    const isHold = finalTier === l.tier;
    if (isUpgrade || isHold) {
      l.tierStableUntil = now + TIER_HOLD_MS;
    }
    l.tier = finalTier;

    return {
      price: l.price,
      strength: l.smoothedStrength,
      isBid: l.price < markPrice,
      tier: finalTier,
      touchCount: l.touchCount,
      winRate: l.winRate,
      reliability: l.reliability,
    };
  });
}

function lineColor(strength: number, isBid: boolean): { r: number; g: number; b: number } {
  if (strength < 0.3) {
    return { r: 60, g: 90, b: 140 };
  } else if (strength < 0.55) {
    const t = (strength - 0.3) / 0.25;
    return {
      r: 60 - Math.round(t * 30),
      g: 90 + Math.round(t * 80),
      b: 140 + Math.round(t * 50),
    };
  } else if (strength < 0.8) {
    const t = (strength - 0.55) / 0.25;
    return {
      r: 30 + Math.round(t * 40),
      g: 170 + Math.round(t * 50),
      b: 190 - Math.round(t * 60),
    };
  } else {
    const t = (strength - 0.8) / 0.2;
    return {
      r: 70 + Math.round(t * 120),
      g: 220 + Math.round(t * 30),
      b: 130 - Math.round(t * 80),
    };
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatPrice(price: number, precision?: string): string {
  if (precision && precision !== "default") {
    const n = parseInt(precision, 10);
    if (Number.isFinite(n)) return price.toFixed(n);
  }
  if (price >= 10000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

function calculateGridStep(range: number): number {
  const rawStep = range / 8;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let step: number;
  if (normalized < 1.5) step = 1;
  else if (normalized < 3.5) step = 2;
  else if (normalized < 7.5) step = 5;
  else step = 10;
  return step * magnitude;
}

// Vertical zoom clamp. Wide range (0.05× – 50×) so traders can pin
// candles for fine wick reading at the lower bound and pull far-away
// elite/strong levels into view at the upper bound, matching
// TradingView's price-axis feel. Padding-math guards in the render
// path keep the extremes safe (no negative ticks, no zero-range view).
// Hoisted to module scope so React hook dependency analysis treats
// them as stable literals.
const V_ZOOM_MIN = 0.05;
const V_ZOOM_MAX = 50;

// timeframeSwitchPerfV1: chart timeframe switching should paint quickly.
// Keep protected engine lookback untouched; only reduce the first visual candle
// request, then lazily expand history after the chart is already usable.
const FULL_CANDLE_HISTORY_LIMIT = 10000;
const FAST_CANDLE_LIMIT_BY_INTERVAL: Record<string, number> = {
  "1m": 900,
  "3m": 1000,
  "5m": 1200,
  "15m": 1500,
  "30m": 1600,
  "1H": 1800,
  "2H": 1800,
  "4H": 1800,
  "6H": 1600,
  "12H": 1500,
  "1D": 1200,
  "3D": 900,
  "1W": 700,
  "1M": 500,
};

function fastCandleLimitForInterval(interval: string): number {
  return FAST_CANDLE_LIMIT_BY_INTERVAL[interval] ?? 1500;
}

function adjacentIntervalsForPrefetch(interval: Interval): Interval[] {
  const idx = INTERVALS.indexOf(interval);
  if (idx < 0) return [];
  const out: Interval[] = [];
  const prev = INTERVALS[idx - 1];
  const next = INTERVALS[idx + 1];
  if (prev) out.push(prev);
  if (next) out.push(next);
  return out;
}

interface PlotTransform {
  chartW: number;
  chartH: number;
  startIdx: number;
  endIdx: number;
  total: number;
  candleSpacing: number;
  minPrice: number;
  maxPrice: number;
  priceRange: number;
  useLog: boolean;
  logMin: number;
  logRange: number;
}

function priceToYFromTransform(tx: PlotTransform, price: number): number {
  if (tx.useLog && price > 0) {
    return (1 - (Math.log(price) - tx.logMin) / tx.logRange) * tx.chartH;
  }
  return (1 - (price - tx.minPrice) / tx.priceRange) * tx.chartH;
}

function yToPriceFromTransform(tx: PlotTransform, y: number): number {
  const clampedY = Math.max(0, Math.min(tx.chartH, y));
  const pct = 1 - clampedY / Math.max(1, tx.chartH);
  if (tx.useLog) return Math.exp(tx.logMin + pct * tx.logRange);
  return tx.minPrice + pct * tx.priceRange;
}

function isDrawableTool(tool: DrawingToolId): tool is Exclude<DrawingToolId, "cursor" | "zoom"> {
  return tool !== "cursor" && tool !== "zoom";
}

export function HeatmapChart({ data, isLoading, symbol = "BTC-USDT", interval = "4H", requestVisibleBars, highlight = null, onDismissHighlight, onLevelClick, compact = false }: HeatmapChartProps) {
  const { settings, openTo, set } = useChartSettings();
  const drawingState = useDrawingState();
  const [editingIndicatorId, setEditingIndicatorId] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // chartStabilityModulesV1: secondary overlays are gated until the selected
  // chart has matching candle data and has settled for a short delay.
  const [chartReadyForOverlays, setChartReadyForOverlays] = useState(false);

  const sl = settings.structuralLevels ?? {
    enabled: false,
    minConfidence: "medium" as const,
    showLabels: true,
    fillOpacity: 0.5,
    methods: {
      "kde-pivot-cluster": true,
      "market-profile-poc": true,
      "value-area-high": true,
      "value-area-low": true,
      "swing-pivot": true,
      "quantile-band": true,
    },
  };
  const { filteredZones: structuralZones, unsupported: structuralUnsupported } = useStructuralLevels({
    symbol,
    interval,
    enabled: !!sl.enabled,
    minConfidence: sl.minConfidence,
    methodsAllowed: sl.methods,
  });
  // Persistent registry levels — loaded from Postgres immediately at boot
  // and kept in sync over the `levels:<symbol>` WS channel. We use these
  // as a cold-start substitute for the locally-detected level pipeline so
  // the chart shows familiar lines IMMEDIATELY after an API server restart
  // instead of waiting for the structural-levels engine to warm up.
  const registryLevels = useRegistryLevels(symbol);
  const registryLevelsRef = useRef(registryLevels);
  registryLevelsRef.current = registryLevels;
  const structuralZonesRef = useRef(structuralZones);
  structuralZonesRef.current = structuralZones;
  const structuralLabelsRef = useRef(sl.showLabels);
  structuralLabelsRef.current = sl.showLabels;
  const structuralFillOpacityRef = useRef(sl.fillOpacity);
  structuralFillOpacityRef.current = sl.fillOpacity;

  // Analytics overlays (funding divergence, OI delta, taker pressure, real
  // CVD, liquidation magnet zones). The hook stays idle when no overlays
  // are enabled, so users who don't opt in pay no network/CPU cost.
  const overlayCfg = settings.analyticsOverlays ?? { funding: false, oiDelta: false, takerPressure: false, cvd: false, magnetZones: false };
  // Compact tiles (grid layout) hide the chip bar and have very limited
  // pixel real-estate, so we also suppress the overlay polling/rendering
  // there. Users see overlays only on the focused chart.
  const anyOverlayEnabled = chartReadyForOverlays && !compact && (overlayCfg.funding || overlayCfg.oiDelta || overlayCfg.takerPressure || overlayCfg.cvd || overlayCfg.magnetZones);
  const { analytics: analyticsData, magnets: magnetClusters } = useAnalyticsOverlays(symbol, anyOverlayEnabled);
  const analyticsRef = useRef<AnalyticsOverlaysData | null>(analyticsData);
  analyticsRef.current = analyticsData;
  const magnetsRef = useRef<MagnetCluster[]>(magnetClusters);
  magnetsRef.current = magnetClusters;

  // Real liquidation-cluster feed for the "Liquidation Heatmap (Real)"
  // indicator. Only polls when the indicator is actually present, so users
  // who don't add it pay no network cost.
  const realLiqIndicator = !compact ? settings.indicators.find(
    (i) => i.type === "liq_heatmap_real" && i.visible !== false,
  ) : undefined;
  const realLiqEnabled = chartReadyForOverlays && !!realLiqIndicator;
  // Window is configurable per-indicator (default 15 min). Cap at 7d to
  // match the API server's persistence retention; the server clamps too,
  // but capping client-side keeps the URL honest.
  const realLiqWindowMinutes = Math.min(
    7 * 24 * 60,
    Math.max(1, Math.floor(realLiqIndicator?.params?.windowMinutes ?? 15)),
  );
  const realLiqClusters = useLiquidationClusters(
    symbol,
    realLiqEnabled,
    realLiqWindowMinutes * 60_000,
  );
  const realLiqClustersRef = useRef<LiquidationCluster[]>(realLiqClusters);
  realLiqClustersRef.current = realLiqClusters;
  const overlayCfgRef = useRef(overlayCfg);
  overlayCfgRef.current = overlayCfg;

  // Scanner-driven highlight overlay. Stored in refs so the (already-large)
  // renderChart dep list doesn't grow, but we still re-render whenever the
  // highlight identity changes (effect below).
  const highlightRef = useRef<HeatmapHighlight | null>(highlight);
  highlightRef.current = highlight;
  const onDismissHighlightRef = useRef<typeof onDismissHighlight>(onDismissHighlight);
  onDismissHighlightRef.current = onDismissHighlight;
  const dismissHighlightOnInteract = useCallback(() => {
    if (highlightRef.current && onDismissHighlightRef.current) {
      onDismissHighlightRef.current();
    }
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotTransformRef = useRef<PlotTransform | null>(null);
  const drawingStateRef = useRef(drawingState);
  drawingStateRef.current = drawingState;
  const draftDrawingRef = useRef<Omit<ChartDrawing, "id" | "createdAt"> | null>(null);
  const drawingGestureRef = useRef<{ tool: DrawingToolId; points: DrawingPoint[] } | null>(null);
  // Populated by the render loop each frame with the current on-screen
  // position (y pixel) of every persistent level line. Used by the
  // double-click handler below to hit-test which level the user hit.
  const renderedLevelsRef = useRef<Array<{ price: number; y: number; isBid: boolean; tier: "elite" | "strong" | "normal" }>>([]);
  // levelOverlayZoomStabilityV1: zoom/pan must only transform already-discovered
  // levels; it must not cause the chart to recompute, decay, retier, or replace
  // the overlay set. The cache key below intentionally excludes viewport bounds.
  // Display-only stability; protected engine formulas and scoring untouched.
  const stableLevelOverlayRef = useRef<{ key: string; lines: LiquidityLine[] } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  const viewRef = useRef({ startIdx: -1, endIdx: -1 });
  const totalCandlesRef = useRef(0);
  const candleStateRef = useRef<{ loading: boolean; errored: boolean }>({ loading: true, errored: false });
  const dragRef = useRef({
    active: false,
    mode: "pan" as "pan" | "yaxis" | "xaxis",
    startX: 0,
    startY: 0,
    origStart: 0,
    origVisible: 0,
    origVZoom: 1,
  });
  const verticalZoomRef = useRef(1);
  // Fit-to-levels hotkey ("F"): fitRequestRef is set by the keydown handler
  // and consumed inside renderChart on the next frame. fitToggleRef stores
  // the pre-fit viewport so a second press restores it.
  const fitRequestRef = useRef<"toggle" | null>(null);
  const fitToggleRef = useRef<{ vZoom: number; startIdx: number; endIdx: number } | null>(null);
  const userInteractedRef = useRef(false);
  const PRICE_AXIS_W = 85;
  const TIME_AXIS_H = 28;
  const [isDragging, setIsDragging] = useState(false);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  // Touch parking: a single tap on the chart pins the crosshair so the user
  // can read the tooltip without their finger covering it. Mirrors hoverRef
  // when set; cleared on outside tap, new pan/pinch, or settings change.
  const parkedRef = useRef<{ x: number; y: number } | null>(null);
  // Active pointers for multi-touch (pinch) handling. Pointer-id keyed so we
  // can correctly track two fingers even on devices that interleave events.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Pinch gesture snapshot: distance/midpoint at start + view state to scale
  // from. Cleared on pointerup of either finger.
  const pinchRef = useRef<{
    startDist: number;
    startMidX: number;
    startMidY: number;
    startStartIdx: number;
    startVisible: number;
    startVZoom: number;
  } | null>(null);
  // Tap/long-press classifier for single-touch input. Holds the raw start
  // event data + the long-press timer id; nullified once the gesture is
  // resolved (drag, tap, or long-press fired).
  const tapRef = useRef<{
    pointerId: number;
    startTime: number;
    startX: number;
    startY: number;
    longPressTimer: number | null;
    candidate: boolean;
  } | null>(null);

  // fastChartCandlesV2: render from a compact recent-history request by
  // default and do NOT auto-upgrade to a 5k request on every symbol/timeframe
  // change. The network panel showed repeated 5000-bar calls competing with
  // active chart interaction. Full/deep history is now opt-in via
  // VITE_AUTO_FULL_CANDLE_HISTORY=1, while engine lookback/formulas stay
  // untouched. UI/data transport only.
  const FAST_CANDLE_LIMIT = Math.min(
    2_500,
    Math.max(500, Number(import.meta.env.VITE_FAST_CHART_CANDLE_LIMIT ?? "1800") || 1_800),
  );
  const FULL_CANDLE_LIMIT = Math.min(
    5_000,
    Math.max(FAST_CANDLE_LIMIT, Number(import.meta.env.VITE_CHART_CANDLE_LIMIT ?? String(FAST_CANDLE_LIMIT)) || FAST_CANDLE_LIMIT),
  );
  const AUTO_FULL_CANDLE_HISTORY = import.meta.env.VITE_AUTO_FULL_CANDLE_HISTORY === "1";
  const [candleLimit, setCandleLimit] = useState(FAST_CANDLE_LIMIT);
  useEffect(() => {
    setCandleLimit(FAST_CANDLE_LIMIT);
    if (!AUTO_FULL_CANDLE_HISTORY || FULL_CANDLE_LIMIT <= FAST_CANDLE_LIMIT) return;
    const delayMs = Math.max(
      10_000,
      Number(import.meta.env.VITE_FULL_CANDLE_HISTORY_DELAY_MS ?? "30000") || 30_000,
    );
    const timer = window.setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setCandleLimit(FULL_CANDLE_LIMIT);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [symbol, interval, FAST_CANDLE_LIMIT, FULL_CANDLE_LIMIT, AUTO_FULL_CANDLE_HISTORY]);
  // retry: bounded retries with backoff so an aborted-in-flight initial
  // request (e.g. AbortController fired by a transient mount/unmount race
  // during HMR or rapid prop change) recovers automatically instead of
  // leaving react-query stuck in a permanent `isLoading: true` state.
  // Without retries, refetchInterval cannot recover because react-query
  // does not fire the interval while the query is still in `pending`.
  // refetchOnMount: "always" guarantees a fresh fetch on every chart
  // remount, defeating any inherited stale pending state from a prior
  // mount of the same query key.
  const { data: candleResponse, error: candleError, isLoading: candlesLoading, refetch: refetchCandles } = useGetCandles(
    { symbol, interval, limit: candleLimit },
    {
      query: {
        refetchInterval: 60000,
        staleTime: 60000,
        // latencyCleanupV2: one retry is enough for transient aborts; more
        // retries can amplify provider pressure during HL/OKX/Toobit instability.
        retry: 1,
        retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 8000),
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    }
  );
  candleStateRef.current = {
    loading: candlesLoading,
    errored: !!candleError,
  };

  // chartStabilityModulesV1: give primary chart data priority. Overlay polling
  // remains disabled until matching candles are present, not loading, not
  // errored, and the chart has had a short settle window. This prevents
  // secondary analytics/liquidation requests from competing with candle/level
  // loads during rapid symbol/timeframe changes.
  useEffect(() => {
    setChartReadyForOverlays(false);
    const ready = isChartReadyForOverlays({
      symbol,
      interval,
      candleCount: candleResponse?.candles?.length ?? 0,
      candlesLoading,
      candleErrored: !!candleError,
    });
    if (!ready) return;
    const timer = window.setTimeout(() => {
      setChartReadyForOverlays(true);
    }, chartOverlaySettleDelayMs());
    return () => window.clearTimeout(timer);
  }, [symbol, interval, candleResponse?.candles?.length, candlesLoading, candleError]);

  // Stuck-loading watchdog: react-query treats AbortController cancellations
  // as intentional (not retryable), so a request that gets aborted before
  // it completes can leave the query permanently in `pending` with no data.
  // If `candlesLoading` stays true longer than 7s, force a manual refetch
  // to recover. Scoped to candle query only — does not touch engine math
  // or liquidity/structural generation.
  // cancelRefetch:false avoids aborting a legitimate slow request that is
  // simply still in flight (backend cold-miss can take 5–6s).
  useEffect(() => {
    if (!candlesLoading) return;
    const timer = setTimeout(() => {
      try { refetchCandles({ cancelRefetch: false }); } catch { /* noop */ }
    }, candleWatchdogDelayMs());
    return () => clearTimeout(timer);
  }, [candlesLoading, refetchCandles, symbol, interval]);

  // timeframeSwitchPerfV1: adjacent timeframe prefetch is now opt-in.
  // The mobile network trace showed rapid timeframe sweeps creating extra
  // background /candles and /levels calls for neighboring intervals, which
  // increased 502/503 pressure. Leave the helper available, but default it
  // off unless VITE_TIMEFRAME_PREFETCH=1 is explicitly set. UI/data
  // transport only; protected engines untouched.
  useEffect(() => {
    const enabled = import.meta.env.VITE_TIMEFRAME_PREFETCH === "1";
    if (!enabled) return;
    if (!symbol || !interval || !candleResponse?.candles?.length) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    const controller = new AbortController();
    const delayMs = Math.max(
      1500,
      Number(import.meta.env.VITE_TIMEFRAME_PREFETCH_DELAY_MS ?? "2500") || 2_500,
    );
    const timer = window.setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const nextInterval of adjacentIntervalsForPrefetch(interval)) {
        prefetchStructuralLevels(symbol, nextInterval);
        const limit = fastCandleLimitForInterval(nextInterval);
        const url = apiUrl(
          `/api/liquidity/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(nextInterval)}&limit=${limit}`,
        );
        fetch(url, {
          signal: controller.signal,
          credentials: "include",
          cache: "no-store",
          headers: {
            "x-fetch-priority": "low",
            "x-prefetch-reason": "timeframe-switch",
          },
        }).catch(() => {});
      }
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [symbol, interval, candleResponse?.candles?.length]);

  // Phase 3 / T125 (S5) shadow: every time the legacy useGetCandles hook
  // produces a fresh response, kick off a parallel `fetchCandles` via the
  // IDatafeed and compare the most recent overlapping window. The
  // comparator deliberately does NOT compare raw `.length` because both
  // requests pass through `/api/liquidity/candles?limit=10000` but the
  // backend's response can vary tick-to-tick when the upstream cap or
  // SWR cache state shifts between the two parallel HTTP calls (e.g.
  // HL just returned 5000 to one but the cached payload still has
  // 10000 for the other). What we actually care about during the
  // observation window is whether the two paths agree on the recent
  // bars — same timestamps, same closes — not whether they returned
  // the same total history depth. Disagreements emit one
  // `[datafeed-mismatch] candles:<SYM>|<INTERVAL>:tail` log per
  // response. The chart continues to render the legacy candleResponse
  // exclusively — this is observation only (prefer=legacy) until the
  // observation week completes and a follow-up task removes the legacy
  // path. The check is gated by DATAFEED_SHADOW_ENABLED so users can
  // opt in via VITE_DATAFEED_SHADOW="1" at build time.
  useEffect(() => {
    if (!DATAFEED_SHADOW_ENABLED) return;
    if (!symbol || !interval) return;
    const legacyBars = candleResponse?.candles;
    if (!legacyBars || legacyBars.length === 0) return; // skip cold-start
    // Track which exchange filled the legacy cache slot. The two paths
    // hit the same backend route but their cache slots can be filled by
    // *different* upstream venues if HL was throttled at the moment one
    // of them missed cache. When the two slots are filled by different
    // venues we MUST NOT compare close values bar-for-bar — historical
    // 4H closes legitimately drift ~1-3bps across exchanges (HL vs OKX
    // vs Toobit) because each venue has its own last trade at the bar
    // boundary. Without this gate the shadow comparator was logging
    // `[datafeed-mismatch] candles:BTC-USDT|4H:overlap` for what was
    // really just venue divergence — see the all-symbol audit report.
    const legacySource =
      (candleResponse as unknown as { source?: string } | undefined)?.source ??
      "unknown";
    let cancelled = false;
    void (async () => {
      try {
        const primary = await getDatafeed().fetchCandles({
          symbol,
          resolution: interval as Resolution,
          limit: candleLimit,
        });
        if (cancelled) return;
        const primarySource =
          (primary as unknown as { source?: string }).source ?? "unknown";

        // Cross-source skip: if the two cache slots were filled by
        // different venues, the close-tolerance check is meaningless.
        // Log a structured `cross-source-skip` so the migration team
        // can still see the rate of cross-source fills, but do NOT
        // emit a `[datafeed-mismatch]` since this isn't a feed bug.
        if (
          primarySource !== "unknown" &&
          legacySource !== "unknown" &&
          primarySource !== legacySource
        ) {
          // eslint-disable-next-line no-console
          console.debug(
            `[datafeed-shadow] candles:${symbol}|${interval}:cross-source-skip`,
            { primarySource, legacySource },
          );
          return;
        }

        // Build a timestamp→close map for the legacy tail, then walk
        // the primary tail and only compare bars whose timestamp ALSO
        // appears in the legacy tail. This is the correct overlap
        // semantics: if one path has one extra trailing forming-bar
        // ahead of the other (very common during live updates), we
        // skip it instead of misaligning the entire window. We also
        // ignore bars older than the shared overlap window. The
        // comparator only flags a mismatch when an actually-shared
        // timestamp has divergent closes beyond a 1bps drift, which is
        // what we wanted to observe in the first place. Capped at the
        // last 50 bars on each side for cost; both arrays are
        // server-sorted ascending by timestamp.
        const TAIL = 50;
        const pTail = primary.bars.slice(-TAIL);
        const lTail = legacyBars.slice(-TAIL);
        if (pTail.length === 0 || lTail.length === 0) return;
        const lByTs = new Map<number, number>();
        for (const b of lTail) lByTs.set(b.timestamp, b.close);
        // Drop the most recent shared timestamp from the comparison.
        // The forming/current bar's close moves tick-to-tick on each
        // venue; if both responses happen to include it but were
        // serialized milliseconds apart, the close values will
        // legitimately differ. Excluding it removes the last common
        // false-positive class — only fully-closed historical bars
        // are compared, which is the only place a "feed bug" would
        // actually manifest.
        const overlap: Array<{ ts: number; pClose: number; lClose: number }> = [];
        for (const b of pTail) {
          const lc = lByTs.get(b.time);
          if (lc !== undefined) {
            overlap.push({ ts: b.time, pClose: b.close, lClose: lc });
          }
        }
        if (overlap.length > 1) overlap.pop(); // drop trailing forming bar
        // If the two paths share zero timestamps, there's nothing to
        // compare — that's a window-skew condition (e.g. one path's
        // history starts later), not a content disagreement, and
        // surfacing it would be exactly the kind of false positive we
        // are trying to eliminate.
        if (overlap.length === 0) return;
        shadowCompare(
          `candles:${symbol}|${interval}:overlap`,
          { sample: overlap, len: primary.bars.length, source: primarySource },
          { sample: overlap, len: legacyBars.length, source: legacySource },
          (a) => {
            // Single source of truth (we pre-aligned). Iterate the
            // shared bars and require <=1bps relative close drift on
            // each one. Any single divergent bar fails the equality.
            for (const o of a.sample) {
              const denom = Math.max(Math.abs(o.lClose), 1e-9);
              if (Math.abs(o.pClose - o.lClose) / denom > 1e-4) return false;
            }
            return true;
          },
        );
      } catch {
        // Shadow path is best-effort; never let it surface to users.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candleResponse, symbol, interval, candleLimit]);

  // Anchor candles for liquidity-level analysis. Always 1H + 4H so that the
  // displayed levels stay fixed regardless of which timeframe the chart shows.
  const { data: anchor1H } = useGetCandles(
    { symbol, interval: "1H", limit: 200 },
    { query: { refetchInterval: 120000, staleTime: 120000, refetchOnMount: false, refetchOnWindowFocus: false } }
  );
  const { data: anchor4H } = useGetCandles(
    { symbol, interval: "4H", limit: 200 },
    { query: { refetchInterval: 120000, staleTime: 120000, refetchOnMount: false, refetchOnWindowFocus: false } }
  );

  // Real liquidation events used as a confluence input for level scoring.
  // Same refetch cadence as the rekt sidebar so the two views stay in sync.
  // networkQuietV1: liquidation events are useful, but polling them every
  // 5s during rapid interval switching was visible in the network logs as a
  // repeated /liquidations?limit=200 stream. Keep the data, but slow the REST
  // cadence and avoid retry/window-focus bursts. UI transport only; engines
  // and liquidation math are untouched.
  const { data: liquidationEvents } = useGetLiquidations(
    { symbol, limit: 200 },
    {
      query: {
        refetchInterval: 30000,
        staleTime: 25000,
        retry: 0,
        refetchOnWindowFocus: false,
        enabled: !!symbol,
      },
    }
  );

  const liqSamples = useMemo<RawLiquidation[]>(() => {
    if (!liquidationEvents) return [];
    return liquidationEvents.map((l) => ({ price: l.price, usdValue: l.usdValue }));
  }, [liquidationEvents]);

  const apiCandles = useMemo((): Candle[] | null => {
    if (!candleResponse?.candles?.length) return null;
    return candleResponse.candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: (c as { volume?: number }).volume,
    }));
  }, [candleResponse]);

  // latencyCleanupV2: display-only last-good fallback. This prevents a blank
  // chart on a transient cold-miss/503 for the same symbol+interval. It never
  // fabricates candles for engines, levels, scoring, or confluence.
  useEffect(() => {
    rememberLastGoodCandles(symbol, interval, apiCandles);
  }, [symbol, interval, apiCandles]);
  const displayApiCandles = useMemo((): Candle[] | null => {
    return displayCandlesWithFallback(symbol, interval, apiCandles, !!candleError) as Candle[] | null;
  }, [symbol, interval, apiCandles, candleError]);

  // Combined 1H + 4H candle set for level analysis. Dedup by timestamp and
  // sort ascending. Fed to extractLiquidityLines + mergeAndPersistLevels
  // instead of the display-interval candles, so 1H/4H levels stay anchored.
  const anchorCandles = useMemo((): Candle[] | null => {
    const c1 = anchor1H?.candles ?? [];
    const c4 = anchor4H?.candles ?? [];
    if (!c1.length && !c4.length) return null;
    const map = new Map<number, Candle>();
    for (const c of c4) {
      map.set(c.timestamp, { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    for (const c of c1) {
      // 1H takes precedence at overlapping timestamps (more granular touches)
      map.set(c.timestamp, { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [anchor1H, anchor4H]);

  useEffect(() => {
    viewRef.current = { startIdx: -1, endIdx: -1 };
  }, [interval, symbol]);

  // External range request from the bottom range bar (1D / 5D / 1M / All).
  // Anchors the right edge to the latest bar and shows N most-recent bars,
  // clamped to the available data length.
  useEffect(() => {
    if (!requestVisibleBars || requestVisibleBars < 2) return;
    const total = totalCandlesRef.current;
    if (total < 2) return;
    const want = isFinite(requestVisibleBars) ? Math.min(requestVisibleBars, total) : total;
    viewRef.current = { startIdx: Math.max(0, total - want), endIdx: total };
    // Trigger a re-render via the existing scheduling path.
    if (canvasRef.current) {
      const evt = new Event("resize");
      window.dispatchEvent(evt);
    }
  }, [requestVisibleBars]);

  const renderChart = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const W = container.clientWidth;
    const H = container.clientHeight;
    if (W < 50 || H < 50) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // chartRuntimeRegressionFixV1: candle-first fallback. If heatmap/orderbook
    // context is missing but real candles are present, keep rendering the chart
    // using a minimal display-only context seeded from the latest candle. This
    // does not fabricate engine levels or feed any protected formula path.
    const fallbackCandlesForRender = displayApiCandles ?? apiCandles;
    const fallbackLastCandle = fallbackCandlesForRender?.[fallbackCandlesForRender.length - 1];
    const renderData = data ?? (fallbackLastCandle
      ? ({
          symbol: normalizeSymbolKey(symbol),
          markPrice: fallbackLastCandle.close,
          bids: [],
          asks: [],
          updatedAt: new Date(fallbackLastCandle.timestamp).toISOString(),
        } as any)
      : null);

    // When upstream heatmap data is unavailable (loading or error), clear
    // the canvas to its empty state and surface a status message rather
    // than letting a previously-rendered symbol's chart linger on screen.
    if (!renderData) {
      const dprNoData = window.devicePixelRatio || 1;
      prepareCanvasFrame(canvas, ctx, W, H, dprNoData);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(0, 0, W, H);
      const { loading, errored } = candleStateRef.current;
      const message = errored && !loading ? "Chart data unavailable" : "Loading chart…";
      ctx.fillStyle = errored && !loading ? "rgba(248,113,113,0.85)" : "rgba(148,163,184,0.7)";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(message, W / 2, H / 2);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    prepareCanvasFrame(canvas, ctx, W, H, dpr);

    const PRICE_AXIS_W = 85;
    const TIME_AXIS_H = 28;
    const LABEL_H = 22;
    const chartW = Math.max(100, W - PRICE_AXIS_W);
    const chartH = Math.max(100, H - TIME_AXIS_H - LABEL_H);

    // Reserve a strip at the bottom of chartH for sub-pane indicators (RSI/MACD/Volume)
    const subPaneIndicators = settingsRef.current.indicators.filter((i) => i.pane === "below" && i.visible !== false);
    const SUB_PANE_H_EACH = 90;
    const subPaneH = Math.min(chartH * 0.6, subPaneIndicators.length * SUB_PANE_H_EACH);
    const priceAreaH = Math.max(80, chartH - subPaneH);

    const chartSymbol = renderData.symbol || "BTCUSDT";
    const intervalMs = INTERVAL_MS[interval] ?? INTERVAL_MS["4H"];
    // Real-only: when the API hasn't delivered candles yet (cold start
    // or 503 from the candles route), `allCandles` is empty and the
    // canvas renders the loading overlay below. Live mark-price ticks
    // are folded into the seeded series so the rightmost bar tracks
    // the tape between API refetches.
    const allCandles: Candle[] = displayApiCandles
      ? updateCandleStore(chartSymbol, renderData.markPrice, intervalMs, displayApiCandles)
      : [];
    const MIN_VISIBLE = 10;
    const MAX_VISIBLE = allCandles.length;

    // IMPORTANT: read prevTotal BEFORE writing the new value so the
    // slide-to-right-edge branch below can detect history streaming in
    // (e.g. paginated 10k 1m bars arriving after the initial 200).
    const prevTotal = totalCandlesRef.current;
    totalCandlesRef.current = allCandles.length;

    if (
      viewRef.current.startIdx < 0 ||
      viewRef.current.endIdx > allCandles.length ||
      viewRef.current.endIdx <= 0
    ) {
      // First load (or candles shrank): start with ~500 bars visible. This is
      // a comfortable default that shows enough history without crushing the
      // wicks; zoom-out can then expand to the full CANDLE_LIMITS budget.
      const initVisible = Math.min(500, allCandles.length);
      viewRef.current = {
        startIdx: allCandles.length - initVisible,
        endIdx: allCandles.length,
      };
    } else if (
      viewRef.current.endIdx === prevTotal &&
      allCandles.length > prevTotal
    ) {
      // History stream-in (e.g. paginated 10k 1m bars after initial 200):
      // the user was anchored to the right edge, so slide the window to the
      // new right edge while preserving the visible width. Without this,
      // the view would stay pinned to the OLDEST candles and zoom-out would
      // appear broken.
      const visibleWidth = viewRef.current.endIdx - viewRef.current.startIdx;
      viewRef.current = {
        startIdx: allCandles.length - visibleWidth,
        endIdx: allCandles.length,
      };
    }

    const { startIdx, endIdx } = viewRef.current;
    const candles = allCandles.slice(startIdx, endIdx);
    if (candles.length === 0) {
      // Honest empty. Distinguish three states so the user is never
      // misled into thinking we have data we don't:
      //   - errored:  /liquidity/candles returned 503 / network failed
      //               => "Candles unavailable"
      //   - loading:  in-flight cold-start fetch => "Loading candles…"
      //   - neither:  truly nothing yet (e.g. brand-new symbol mount)
      //               => "Loading candles…" (will retry on next tick)
      // Always clears the canvas first so prior chart visuals can never
      // bleed through and falsely represent the new symbol's state.
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(0, 0, W, H);
      const { loading, errored } = candleStateRef.current;
      const message = errored
        ? "Candles unavailable"
        : loading
          ? "Loading candles…"
          : "Loading candles…";
      ctx.fillStyle = errored ? "rgba(248,113,113,0.85)" : "rgba(148,163,184,0.7)";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(message, W / 2, H / 2);
      return;
    }

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of candles) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }
    const cs = settingsRef.current;

    // Consume any pending fit-to-levels request from the "F" hotkey before
    // computing padding so the new vertical zoom takes effect this frame.
    if (fitRequestRef.current === "toggle") {
      fitRequestRef.current = null;
      if (fitToggleRef.current) {
        verticalZoomRef.current = fitToggleRef.current.vZoom;
        viewRef.current = {
          startIdx: fitToggleRef.current.startIdx,
          endIdx: fitToggleRef.current.endIdx,
        };
        fitToggleRef.current = null;
        scheduleRenderRef.current();
        return;
      }
      const fitSymKey = normalizeSymbolKey(chartSymbol);
      const regLevels = levelRegistries[fitSymKey];
      if (regLevels && renderData.markPrice > 0) {
        const targets = regLevels.filter(
          (l) => l.tier === "elite" || l.tier === "strong",
        );
        if (targets.length > 0) {
          let lMin = minPrice;
          let lMax = maxPrice;
          for (const l of targets) {
            if (l.price < lMin) lMin = l.price;
            if (l.price > lMax) lMax = l.price;
          }
          const range0Fit = Math.max(1e-9, maxPrice - minPrice);
          const marginTopPct = Math.max(0.001, cs.canvas.marginTop / 100);
          const marginBotPct = Math.max(0.001, cs.canvas.marginBottom / 100);
          // Reverse the padding math used below (3.5× multiplier) and add a
          // 10% headroom so the furthest level isn't pinned to the edge.
          const HEADROOM = 1.1;
          const neededTop =
            Math.max(0, lMax - maxPrice) / (range0Fit * 3.5 * marginTopPct);
          const neededBot =
            Math.max(0, minPrice - lMin) / (range0Fit * 3.5 * marginBotPct);
          const fitVZoom = Math.max(neededTop, neededBot, 1) * HEADROOM;
          const clamped = Math.max(
            V_ZOOM_MIN,
            Math.min(V_ZOOM_MAX, fitVZoom),
          );
          if (clamped !== verticalZoomRef.current) {
            fitToggleRef.current = {
              vZoom: verticalZoomRef.current,
              startIdx,
              endIdx,
            };
            verticalZoomRef.current = clamped;
            scheduleRenderRef.current();
            return;
          }
        }
      }
    }

    const topPad = (cs.canvas.marginTop / 100) * verticalZoomRef.current;
    const botPad = (cs.canvas.marginBottom / 100) * verticalZoomRef.current;
    const range0 = maxPrice - minPrice;
    // Guard against degenerate windows. With the extended zoom range
    // (V_ZOOM_MIN..V_ZOOM_MAX) the padding multiplier can run from
    // ~0.001 up to ~90× of range0; on low-priced pairs the bottom pad
    // could otherwise push minPrice negative, and on a single-doji view
    // range0 can be 0, which would zero out priceRange and divide by it.
    const candleLow = minPrice;
    const candleHigh = maxPrice;
    minPrice -= range0 * botPad * 3.5;
    maxPrice += range0 * topPad * 3.5;
    // Never let the bottom of the chart cross 0 — for low-priced pairs
    // (DOGE, SHIB, etc.) extreme zoom-out would otherwise produce
    // negative price ticks. Clamp to 1% of the lowest candle low. When
    // zoom-out crosses this floor the bottom edge stops expanding while
    // the top keeps growing — a one-time, intentional transition.
    if (minPrice < candleLow * 0.01) minPrice = candleLow * 0.01;
    // Never let the visible window collapse to zero — a doji-only view
    // would otherwise divide by zero in priceToY.
    if (maxPrice - minPrice < 1e-9) maxPrice = minPrice + Math.max(1e-9, candleLow * 1e-6);

    // Expand the visible price window so *nearby* strong/elite levels can come
    // into view without the user having to zoom out, while keeping candles as
    // the primary scale driver. The key safety rule here is: only the nearest
    // level just outside the visible candle range may influence the fit on each
    // side, and even then the extension is capped. That keeps local confluence
    // visible without letting distant stale levels vertically flatten the chart.
    // registryLevelFit15mV1
    // Include registry-backed levels in the auto-fit pass BEFORE the visible
    // line filter runs. On narrow 15m views, registry levels used to be merged
    // later in the frame, after minPrice/maxPrice were fixed, so they could be
    // immediately filtered out as off-screen. This is display-only fitting; it
    // does not alter any level formulas, scores, confluence, or touch rules.
    const symbolKey = normalizeSymbolKey(chartSymbol);
    const existingLevels = levelRegistries[symbolKey] ?? [];
    const registryFitLevels: Array<{ price: number; tier: "elite" | "strong" | "normal" }> =
      (registryLevelsRef.current ?? []).map((l) => ({
        price: l.price,
        tier: l.tier >= 3 ? "elite" : l.tier === 2 ? "strong" : "normal",
      }));
    const fitLevels: Array<{ price: number; tier: "elite" | "strong" | "normal" }> = [
      ...existingLevels.map((l) => ({ price: l.price, tier: l.tier })),
      ...registryFitLevels,
    ];
    if (fitLevels.length > 0 && renderData.markPrice > 0) {
      const hasRegistryLevels = registryFitLevels.length > 0;
      const fitRangeMultiplier = hasRegistryLevels
        ? Math.max(OVERLAY_FIT_RANGE_MULTIPLIER, 0.65)
        : OVERLAY_FIT_RANGE_MULTIPLIER;
      const fitMaxExtensionMultiplier = hasRegistryLevels
        ? Math.max(OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER, 0.45)
        : OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER;
      const fitLo = candleLow - range0 * fitRangeMultiplier;
      const fitHi = candleHigh + range0 * fitRangeMultiplier;
      const fitPad = Math.max(
        range0 * OVERLAY_FIT_PAD_MULTIPLIER,
        renderData.markPrice * 0.0006,
      );
      const maxExtension = range0 * fitMaxExtensionMultiplier;
      let nearestBelow: number | null = null;
      let nearestAbove: number | null = null;
      for (const lvl of fitLevels) {
        if (lvl.tier !== "elite" && lvl.tier !== "strong") continue;
        if (lvl.price < fitLo || lvl.price > fitHi) continue;
        if (lvl.price < candleLow) {
          if (nearestBelow == null || lvl.price > nearestBelow) nearestBelow = lvl.price;
        } else if (lvl.price > candleHigh) {
          if (nearestAbove == null || lvl.price < nearestAbove) nearestAbove = lvl.price;
        }
      }
      if (nearestBelow != null) {
        const belowTarget = nearestBelow - fitPad;
        minPrice = Math.max(belowTarget, minPrice - maxExtension);
      }
      if (nearestAbove != null) {
        const aboveTarget = nearestAbove + fitPad;
        maxPrice = Math.min(aboveTarget, maxPrice + maxExtension);
      }
    }

    const priceRange = maxPrice - minPrice;

    // Scale mode: "log" applies natural-log mapping so % moves of equal size
    // appear visually equal at any price level (TradingView-style log scale).
    // "percent" pins the right edge of the visible window to 0% and shows
    // everything else as % delta from that anchor. "regular"/"auto" both use
    // linear mapping (auto is just regular with auto-fit).
    const scaleMode = cs.canvas.priceScaleMode ?? "auto";
    const useLog = scaleMode === "log" && minPrice > 0;
    const logMin = useLog ? Math.log(minPrice) : 0;
    const logMax = useLog ? Math.log(maxPrice) : 0;
    const logRange = useLog ? logMax - logMin : 1;
    const priceToY = (p: number): number => {
      if (useLog && p > 0) {
        return (1 - (Math.log(p) - logMin) / logRange) * priceAreaH;
      }
      return (1 - (p - minPrice) / priceRange) * priceAreaH;
    };

    // ============ BACKGROUND ============
    ctx.fillStyle = cs.canvas.background || "#0c0c1d";
    ctx.fillRect(0, 0, W, H);

    // Watermark (symbol mode renders ticker low-opacity in chart center)
    if (cs.canvas.watermark === "symbol") {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.font = `bold ${Math.floor(chartH / 5)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((symbol || "").replace("-", "").replace("USDT", ""), chartW / 2, chartH / 2);
      ctx.restore();
    } else if (cs.canvas.watermark === "replay") {
      ctx.save();
      ctx.fillStyle = "rgba(255,200,80,0.06)";
      ctx.font = `bold ${Math.floor(chartH / 6)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("REPLAY", chartW / 2, chartH / 2);
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, chartW, priceAreaH);
    ctx.clip();

    // Grid lines (horizontal/vertical/both/none)
    const gridStep = calculateGridStep(priceRange);
    const gridStart = Math.ceil(minPrice / gridStep) * gridStep;
    if (cs.canvas.gridLines === "horizontal" || cs.canvas.gridLines === "both") {
      ctx.strokeStyle = cs.canvas.gridColor || "rgba(255,255,255,0.025)";
      ctx.lineWidth = 1;
      for (let p = gridStart; p <= maxPrice; p += gridStep) {
        const y = Math.round(priceToY(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chartW, y);
        ctx.stroke();
      }
    }
    if (cs.canvas.gridLines === "vertical" || cs.canvas.gridLines === "both") {
      ctx.strokeStyle = cs.canvas.gridColor || "rgba(255,255,255,0.025)";
      ctx.lineWidth = 1;
      const vStep = Math.max(1, Math.floor(candles.length / 8));
      for (let i = 0; i < candles.length; i += vStep) {
        const x = Math.round(5 + i * (chartW - 10) / candles.length) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, priceAreaH);
        ctx.stroke();
      }
    }

    // ============ LIQUIDITY LINES ============
    // levelOverlayZoomStabilityV1: level discovery is anchored to stable
    // candle context, never to the current zoom/pan viewport. Zooming should
    // only remap price→Y; it must not replace/retier/decay levels. Use 1H+4H
    // anchors when ready, otherwise the full current-interval candle store —
    // not the visible `candles` slice.
    const levelCandles = anchorCandles ?? allCandles;
    const detectLo = renderData.markPrice * (1 - REMOVAL_DISTANCE);
    const detectHi = renderData.markPrice * (1 + REMOVAL_DISTANCE);
    const dataLevelsForKey = renderData.levels ?? [];
    const firstDataLevel = dataLevelsForKey[0];
    const lastDataLevel = dataLevelsForKey[dataLevelsForKey.length - 1];
    const overlayKey = [
      normalizeSymbolKey(chartSymbol),
      Math.round(renderData.markPrice * 10000) / 10000,
      dataLevelsForKey.length,
      firstDataLevel ? Number(firstDataLevel.price).toFixed(6) : "none",
      lastDataLevel ? Number(lastDataLevel.price).toFixed(6) : "none",
      levelCandles.length,
      anchorCandles ? "anchor" : "display",
      registryLevelsRef.current.length,
      liqSamples.length,
    ].join("|");

    let consolidated =
      stableLevelOverlayRef.current?.key === overlayKey
        ? stableLevelOverlayRef.current.lines
        : null;

    if (!consolidated) {
      const freshLines = extractLiquidityLines(data, detectLo, detectHi, renderData.markPrice, levelCandles, liqSamples);
      let merged = mergeAndPersistLevels(chartSymbol, freshLines, renderData.markPrice, levelCandles);
      // UNION with persistent registry: always merge the long-term registry
      // levels into the working set so structural majors remain visible.
      if (registryLevelsRef.current.length > 0) {
        const unionTol = renderData.markPrice * VISUAL_CONSOLIDATE_FACTOR;
        const registryProjected = registryLevelsRef.current
          .filter((l) => l.price >= detectLo && l.price <= detectHi)
          .map<LiquidityLine>((l) => ({
            price: l.price,
            strength: Math.min(1, Math.max(0, l.strength)),
            isBid: l.side === "support",
            tier: l.tier >= 3 ? "elite" : l.tier === 2 ? "strong" : "normal",
            touchCount: l.touches,
            winRate: 0,
            reliability: l.reliability,
          }));
        const additions: LiquidityLine[] = [];
        for (const reg of registryProjected) {
          let collides = false;
          for (const existing of merged) {
            if (Math.abs(existing.price - reg.price) <= unionTol) { collides = true; break; }
          }
          if (!collides) additions.push(reg);
        }
        if (additions.length > 0) merged = merged.concat(additions);
      }
      const visualTol = renderData.markPrice * VISUAL_CONSOLIDATE_FACTOR;
      const sorted = [...merged].sort((a, b) => a.price - b.price);
      consolidated = [];
      for (const lvl of sorted) {
        const last = consolidated[consolidated.length - 1];
        if (last && Math.abs(lvl.price - last.price) <= visualTol) {
          const dominant = lvl.strength > last.strength ? { ...lvl } : { ...last };
          const weaker = dominant.price === lvl.price ? last : lvl;
          dominant.strength = Math.min(1, dominant.strength + weaker.strength * 0.2);
          dominant.touchCount = Math.max(dominant.touchCount, weaker.touchCount);
          dominant.reliability = Math.max(dominant.reliability, weaker.reliability);
          dominant.tier = dominant.tier === "elite" || weaker.tier === "elite"
            ? "elite"
            : (dominant.tier === "strong" || weaker.tier === "strong" ? "strong" : "normal");
          consolidated[consolidated.length - 1] = dominant;
        } else {
          consolidated.push({ ...lvl });
        }
      }
      stableLevelOverlayRef.current = { key: overlayKey, lines: consolidated };
    }
    const rawLiqCfg: any = settingsRef.current.liquidity ?? {};
    const liqCfg = {
      showLevels: rawLiqCfg.showLevels ?? true,
      showElite: rawLiqCfg.showElite ?? true,
      showStrong: rawLiqCfg.showStrong ?? true,
      showNormal: rawLiqCfg.showNormal ?? true,
      showBadges: rawLiqCfg.showBadges ?? true,
      glowEnabled: rawLiqCfg.glowEnabled ?? true,
      eliteCount: rawLiqCfg.eliteCount ?? 5,
      strongCount: rawLiqCfg.strongCount ?? 14,
      maxBadges: rawLiqCfg.maxBadges ?? 7,
      minStrength: rawLiqCfg.minStrength ?? 0,
      minTouches: rawLiqCfg.minTouches ?? 0,
      supportColor: rawLiqCfg.supportColor ?? "",
      resistanceColor: rawLiqCfg.resistanceColor ?? "",
      opacityMultiplier: rawLiqCfg.opacityMultiplier ?? 1,
      lineWidthMultiplier: rawLiqCfg.lineWidthMultiplier ?? 1,
      lineStyle: (rawLiqCfg.lineStyle ?? "solid") as OverlayLineStyle,
      colorPalette: (rawLiqCfg.colorPalette ?? "default") as OverlayColorPalette,
    };
    let lines = consolidated.filter((l) => l.price >= minPrice && l.price <= maxPrice);
    if (!liqCfg.showLevels) lines = [];
    // User-driven re-tier override: rank by strength so eliteCount/strongCount
    // are immediately reflected in the chart, then apply tier-show toggles
    // and minimum-strength / minimum-touches filters.
    // To preserve identical default behavior, skip re-tiering when the user
    // has not changed counts from defaults — let the persisted hysteresis tier stand.
    const eliteN = Math.max(0, Math.floor(liqCfg.eliteCount));
    const strongN = Math.max(eliteN, Math.floor(liqCfg.strongCount));
    const usingDefaultCounts = eliteN === 12 && strongN === 30;
    if (lines.length > 0) {
      const tiered = usingDefaultCounts
        ? lines
        : [...lines]
            .sort((a, b) => b.strength - a.strength)
            .map((l, i) => ({
              ...l,
              tier: (i < eliteN ? "elite" : i < strongN ? "strong" : "normal") as "elite" | "strong" | "normal",
            }));
      const hiddenSet = new Set<number>(
        Array.isArray(rawLiqCfg.hiddenLevels) ? rawLiqCfg.hiddenLevels : []
      );
      const hideTol = renderData.markPrice * 0.0008; // ~0.08% match tolerance
      lines = tiered.filter((l) => {
        if (l.strength < liqCfg.minStrength) return false;
        if (l.touchCount < liqCfg.minTouches) return false;
        if (l.tier === "elite" && !liqCfg.showElite) return false;
        if (l.tier === "strong" && !liqCfg.showStrong) return false;
        if (l.tier === "normal" && !liqCfg.showNormal) return false;
        for (const hp of hiddenSet) {
          if (Math.abs(l.price - hp) <= hideTol) return false;
        }
        return true;
      });
    }
    // visualLevelSpacingV1: display compaction only. Keep every real engine
    // level intact, but render a clean representative set so mobile zoom does
    // not collapse many nearby levels into a crowded band. This is based on
    // screen Y-spacing after price mapping; it does NOT recalculate, delete,
    // rescore, retier, or mutate protected engine levels.
    if (lines.length > 1) {
      const minPixelGap = compact
        ? 18
        : Math.max(18, Math.min(36, Number(import.meta.env.VITE_LEVEL_MIN_PIXEL_GAP ?? "26") || 26));
      const maxPerSide = compact
        ? 3
        : Math.max(3, Math.min(8, Number(import.meta.env.VITE_LEVEL_MAX_VISIBLE_PER_SIDE ?? "5") || 5));
      const zonesForPriority = structuralZonesRef.current ?? [];
      const hasSideConfluence = (l: LiquidityLine): boolean =>
        zonesForPriority.some((z) =>
          l.price >= z.priceLow &&
          l.price <= z.priceHigh &&
          (l.isBid ? z.kind === "support" : z.kind === "resistance"),
        );
      const priority = (l: LiquidityLine): number => {
        const tierBoost = l.tier === "elite" ? 60 : l.tier === "strong" ? 32 : 0;
        const confBoost = hasSideConfluence(l) ? 45 : 0;
        const touchBoost = Math.min(12, Math.max(0, l.touchCount)) * 3;
        const reliabilityBoost = Math.max(0, Math.min(1, l.reliability)) * 35;
        return tierBoost + confBoost + touchBoost + reliabilityBoost + l.strength * 100;
      };
      const candidates = lines
        .map((line) => ({ line, y: Math.round(priceToY(line.price)), score: priority(line) }))
        .sort((a, b) => b.score - a.score);
      const selected: typeof candidates = [];
      const sideCounts = { bid: 0, ask: 0 };
      for (const item of candidates) {
        const side = item.line.isBid ? "bid" : "ask";
        if (sideCounts[side] >= maxPerSide) continue;
        const collides = selected.some((kept) => Math.abs(kept.y - item.y) < minPixelGap);
        if (collides) continue;
        selected.push(item);
        sideCounts[side] += 1;
      }
      if (selected.length > 0) {
        // chartRuntimeRegressionFixV1: do not mutate the actual rendered
        // level-line set based on zoom-dependent pixel spacing. Lines must be
        // stable while zooming; only labels/badges may be compacted later.
        const zoomStableLabelCandidates = selected
          .sort((a, b) => a.line.price - b.line.price)
          .map((item) => item.line);
        void zoomStableLabelCandidates;
      }
    }
    // Publish current visible levels so the settings dialog can show them.
    publishLiquidityLevels(
      lines.map((l) => ({
        price: l.price,
        tier: l.tier,
        isBid: l.isBid,
        strength: l.strength,
        touchCount: l.touchCount,
      }))
    );

    // === PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN ===
    // Publish current price-axis state for the left-side DOM ladder /
    // mini-heatmap panel ONLY. This is a one-way READ-ONLY broadcast to
    // a downstream visual consumer. The bus dedupes unchanged snapshots,
    // so this is essentially free when the axis hasn't moved.
    //
    // The DOM ladder is purely an order-flow context display. It must
    // never become part of the structural-levels engine or the liquidity
    // engine, and nothing in this call may grow into a back-channel that
    // influences level discovery, scoring, pivots, quantile bands,
    // confluence, presets, or overlay logic. If you find yourself
    // wanting to feed ladder state back into the chart's engines, stop:
    // the ladder is downstream-only by design.
    // ======================================================
    publishChartAxis({
      symbol: chartSymbol,
      minPrice,
      maxPrice,
      priceAreaH,
      containerH: H,
      scaleMode: useLog ? "log" : "linear",
      markPrice:
        typeof renderData?.markPrice === "number" && Number.isFinite(renderData.markPrice)
          ? renderData.markPrice
          : null,
      priceDecimals: decimalsForPrice(
        typeof renderData?.markPrice === "number" && renderData.markPrice > 0
          ? renderData.markPrice
          : (minPrice + maxPrice) / 2,
      ),
    });

    const parseRgbOverride = (css: string): { r: number; g: number; b: number } | null => {
      if (!css) return null;
      const hex = css.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        const h = hex[1]!;
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
      }
      const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]! };
      return null;
    };
    const supportOverride = parseRgbOverride(liqCfg.supportColor);
    const resistanceOverride = parseRgbOverride(liqCfg.resistanceColor);

    // ============ LEVEL TIER ENGINE (9/8/7 rating) ============
    const useTierEngine = !!rawLiqCfg.useTierEngine;
    const tierEngineHideUnrated = !!rawLiqCfg.tierEngineHideUnrated;
    const tierEngineShowBadges = rawLiqCfg.tierEngineShowBadges ?? true;
    type RatingTier = 0 | 7 | 8 | 9;
    const tierByLineIdx = new Map<number, { rating: RatingTier; reasons: string[] }>();
    if (useTierEngine && lines.length > 0) {
      const classified = classifyLines(
        lines.map((l) => ({
          price: l.price,
          isBid: l.isBid,
          strength: l.strength,
          touchCount: l.touchCount,
          reliability: l.reliability,
        })),
        renderData.markPrice,
      );
      for (let i = 0; i < classified.length; i++) {
        const c = classified[i]!;
        tierByLineIdx.set(i, {
          rating: c.classified.rating as RatingTier,
          reasons: c.classified.reasons,
        });
      }
      if (tierEngineHideUnrated) {
        // Carry forward first-pass ratings; reclassifying a filtered subset
        // would shift the cohort percentile and could downgrade levels back
        // to 0 (leaving unrated lines visible). Instead, keep the original
        // ratings and remap them onto the filtered indices.
        const originalLines = lines;
        const filtered: typeof lines = [];
        const carriedRatings: Array<{ rating: RatingTier; reasons: string[] }> = [];
        for (let i = 0; i < lines.length; i++) {
          const info = tierByLineIdx.get(i);
          if (info && info.rating > 0) {
            filtered.push(lines[i]!);
            carriedRatings.push(info);
          }
        }
        // Fallback: if nothing rated above 0, keep the original lines so the
        // chart never goes blank just because no level qualified for 9/8/7.
        if (filtered.length > 0) {
          tierByLineIdx.clear();
          for (let i = 0; i < carriedRatings.length; i++) {
            tierByLineIdx.set(i, carriedRatings[i]!);
          }
          lines = filtered;
        } else {
          lines = originalLines;
        }
      }
    }
    // ── Confluence-only filter ───────────────────────────────────────────
    // When the user enables "Confluence only" AND both overlays are on,
    // hide depth levels whose price doesn't fall inside any structural
    // zone, and hide structural zones that contain none of the surviving
    // depth levels. Off by default → render is unchanged.
    //
    // Display-only price tolerance: in practice, structural zones are
    // narrow (often 0.1–0.5% wide) and liquidity lines sit on exact
    // ladder prices, so the bilateral exact-inside test frequently
    // returns zero matches even when a setup is visually obvious. We
    // expand each zone by ±5 bps (0.05%) for THIS overlap test ONLY.
    // This does NOT touch engine math, scoring, confluence merge,
    // reliability, regime, touch detection, or registry decay — and it
    // is intentionally not applied to the per-line heat-glow check
    // below (`lineHasStructuralConfluence`) so non-confluence-only
    // rendering stays byte-identical.
    //
    // Edge case: if there are zero structural zones right now,
    // confluence mode still hides everything — the user opted in to
    // "only show confluence", and there is no confluence to show.
    const slSettings = settingsRef.current.structuralLevels;
    const confluenceOn =
      !!slSettings?.confluenceOnly &&
      !!slSettings?.enabled &&
      !!liqCfg.showLevels;
    let confluenceVisibleZones: typeof structuralZonesRef.current | null = null;
    if (confluenceOn) {
      const zonesAvail = structuralZonesRef.current ?? [];
      const strictSide = !!slSettings?.confluenceStrictSide;
      const sideMatches = (lineIsBid: boolean, zoneKind: string) =>
        !strictSide ||
        (lineIsBid ? zoneKind === "support" : zoneKind === "resistance");
      // 5 bps = 0.05% = ~$38 at $77k BTC, ~$2 at $4k ETH.
      // Smaller than typical ladder spacing, large enough to bridge the
      // "just barely outside" gap that drove zero-result frustration.
      const CONFLUENCE_PRICE_TOL_BPS = 5;
      const TOL_FRAC = CONFLUENCE_PRICE_TOL_BPS / 10000;
      const priceInZone = (price: number, zLo: number, zHi: number) => {
        const tol = ((zLo + zHi) / 2) * TOL_FRAC;
        return price >= zLo - tol && price <= zHi + tol;
      };
      lines = lines.filter((l) =>
        zonesAvail.some(
          (z) =>
            priceInZone(l.price, z.priceLow, z.priceHigh) &&
            sideMatches(l.isBid, z.kind),
        ),
      );
      confluenceVisibleZones = zonesAvail.filter((z) =>
        lines.some(
          (l) =>
            priceInZone(l.price, z.priceLow, z.priceHigh) &&
            sideMatches(l.isBid, z.kind),
        ),
      );
    }
    // Shared side-aware confluence helpers used to keep structural zones visually
    // primary while still surfacing where visible liquidity lines overlap them.
    const zonesForOverlay = (confluenceVisibleZones ?? structuralZonesRef.current) ?? [];
    const sideMatchesZone = (lineIsBid: boolean, zoneKind: string) =>
      lineIsBid ? zoneKind === "support" : zoneKind === "resistance";
    const lineHasStructuralConfluence = (price: number, isBid: boolean) =>
      zonesForOverlay.some(
        (z) =>
          price >= z.priceLow &&
          price <= z.priceHigh &&
          sideMatchesZone(isBid, z.kind),
      );

    // Track badges to draw after all lines so they sit on top.
    const tierBadges: Array<{ y: number; rating: RatingTier; color: string }> = [];
    // Reset the hit-test cache each frame — it'll be repopulated below as
    // lines are rendered. The double-click handler consumes this ref.
    renderedLevelsRef.current = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      const y = Math.round(priceToY(line.price));
      renderedLevelsRef.current.push({ price: line.price, y, isBid: line.isBid, tier: line.tier });
      const baseColor = lineColor(line.strength, line.isBid);
      const override = line.isBid ? supportOverride : resistanceOverride;
      // Display-only palette tint: applied only when the user has NOT set
      // an explicit support/resistance color (those still take precedence)
      // and only when palette !== "default" (default returns null and
      // preserves the existing strength-based hue exactly).
      const paletteTint = override ? null : paletteColorFor(liqCfg.colorPalette, line.isBid);
      const { r, g, b } = override ?? paletteTint ?? baseColor;

      let alpha: number;
      let lw: number;
      let glowBlur = 0;
      let glowAlpha = 0;

      if (line.tier === "elite") {
        alpha = 0.65 + line.strength * 0.35;
        lw = 2.25;
        glowBlur = 10 + line.strength * 12;
        glowAlpha = 0.25 + line.strength * 0.45;
      } else if (line.tier === "strong") {
        alpha = 0.45 + line.strength * 0.4;
        lw = line.strength > 0.5 ? 2 : 1.5;
        glowBlur = 4 + line.strength * 6;
        glowAlpha = 0.12 + line.strength * 0.25;
      } else {
        alpha = 0.3 + line.strength * 0.35;
        lw = 1.25;
      }

      // Tier-engine override: when the 9/8/7 system is on, promote rated
      // lines to a distinct gold/green styling regardless of base tier.
      let ratedColor: { r: number; g: number; b: number } | null = null;
      const tierInfo = useTierEngine ? tierByLineIdx.get(lineIdx) : undefined;
      if (tierInfo && tierInfo.rating > 0) {
        const css = tierColor(tierInfo.rating as 7 | 8 | 9);
        if (css) {
          const hex = css.replace("#", "");
          ratedColor = {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
          };
        }
        if (tierInfo.rating === 9) {
          alpha = 1;
          lw = 3;
          glowBlur = 14;
          glowAlpha = 0.5;
        } else if (tierInfo.rating === 8) {
          alpha = 0.92;
          lw = 3;
          glowBlur = 10;
          glowAlpha = 0.4;
        } else if (tierInfo.rating === 7) {
          alpha = 0.95;
          lw = 2;
          glowBlur = 6;
          glowAlpha = 0.3;
        }
        tierBadges.push({ y, rating: tierInfo.rating, color: css || "#D4A017" });
      }

      if (line.reliability > 0.3) {
        const rBoost = 1 + line.reliability * 0.25;
        alpha = Math.min(1, alpha * rBoost);
        glowBlur *= 1 + line.reliability * 0.3;
      }

      // When structural zones are visible, keep non-confluent liquidity lines a
      // little more subdued so structural remains the primary decision layer and
      // overlap areas read immediately.
      const structuralEnabled = !!settingsRef.current.structuralLevels?.enabled;
      const lineConfluent = structuralEnabled && lineHasStructuralConfluence(line.price, line.isBid);
      if (structuralEnabled && zonesForOverlay.length > 0) {
        if (lineConfluent) {
          alpha = Math.min(1, alpha * 1.04);
          lw *= 1.04;
          glowAlpha *= 1.05;
        } else {
          alpha *= 0.82;
          lw *= 0.9;
          glowBlur *= 0.7;
          glowAlpha *= 0.75;
        }
      }

      // Apply user multipliers
      alpha = Math.max(0, Math.min(1, alpha * liqCfg.opacityMultiplier));
      lw = Math.max(0.5, lw * liqCfg.lineWidthMultiplier);
      if (!liqCfg.glowEnabled) glowBlur = 0;

      const sr = ratedColor?.r ?? r;
      const sg = ratedColor?.g ?? g;
      const sb = ratedColor?.b ?? b;
      if (glowBlur > 0) {
        ctx.shadowColor = `rgba(${sr},${sg},${sb},${glowAlpha})`;
        ctx.shadowBlur = glowBlur;
      }

      // Display-only line-dash style. "solid" returns [] which preserves
      // byte-identical behavior with the prior chart. Reset after the
      // line + accent rails so other overlays start with a clean dash.
      const userDash = overlayLineDash(liqCfg.lineStyle) ?? [];
      ctx.setLineDash(userDash);

      ctx.strokeStyle = `rgba(${sr},${sg},${sb},${alpha})`;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(chartW, y + 0.5);
      ctx.stroke();

      if (line.tier === "elite" || (line.tier === "strong" && line.strength > 0.5)) {
        ctx.strokeStyle = `rgba(${sr},${sg},${sb},${alpha * 0.25})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y - 1 + 0.5);
        ctx.lineTo(chartW, y - 1 + 0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, y + 1 + 0.5);
        ctx.lineTo(chartW, y + 1 + 0.5);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    // ============ TIER ENGINE BADGES ============
    if (useTierEngine && tierEngineShowBadges && tierBadges.length > 0) {
      ctx.save();
      ctx.font = "bold 10px ui-sans-serif, system-ui";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const badgeW = 22;
      const badgeH = 14;
      const badgeX = chartW - badgeW - 56; // sit just left of the price axis
      for (const b of tierBadges) {
        ctx.fillStyle = b.color;
        ctx.globalAlpha = 0.95;
        ctx.fillRect(badgeX, b.y - badgeH / 2, badgeW, badgeH);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#000";
        ctx.fillText(`${b.rating}/10`, badgeX + badgeW / 2, b.y);
      }
      ctx.restore();
    }

    // ============ CANDLESTICKS / CHART TYPE ============
    const candleAreaW = chartW - 10;
    const candleSpacing = candleAreaW / candles.length;
    const candleWidth = Math.max(2, Math.min(candleSpacing * 0.6, 12));
    const xAt = (i: number) => 5 + i * candleSpacing + candleSpacing / 2;
    plotTransformRef.current = {
      chartW,
      chartH: priceAreaH,
      startIdx,
      endIdx,
      total: allCandles.length,
      candleSpacing,
      minPrice,
      maxPrice,
      priceRange,
      useLog,
      logMin,
      logRange,
    };

    const sym = cs.symbol;
    const chartType = cs.chartType;

    if (chartType === "candles" || chartType === "hollow_candles") {
      const hollowMode = chartType === "hollow_candles";
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        const x = xAt(i);
        const isGreen = c.close >= c.open;
        const bodyTop = priceToY(Math.max(c.open, c.close));
        const bodyBottom = priceToY(Math.min(c.open, c.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);
        const wickTop = priceToY(c.high);
        const wickBottom = priceToY(c.low);

        if (sym.hollowWick) {
          ctx.strokeStyle = isGreen ? sym.wickUpColor : sym.wickDownColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, wickTop);
          ctx.lineTo(x, wickBottom);
          ctx.stroke();
        }

        // In hollow mode: green candles are outlined (no fill), red are filled.
        // In normal candle mode: respect the per-setting hollowBody flag.
        const fillBody = hollowMode ? !isGreen : sym.hollowBody;
        if (fillBody) {
          ctx.fillStyle = isGreen ? sym.upColor : sym.downColor;
          ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
        }
        if (sym.hollowBorders || hollowMode) {
          ctx.strokeStyle = isGreen ? sym.borderUpColor : sym.borderDownColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - candleWidth / 2 + 0.5, bodyTop + 0.5, candleWidth - 1, bodyHeight - 1);
        }
      }
    } else if (chartType === "line" || chartType === "line_markers" || chartType === "step") {
      ctx.strokeStyle = sym.upColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < candles.length; i++) {
        const x = xAt(i);
        const y = priceToY(candles[i]!.close);
        if (i === 0) ctx.moveTo(x, y);
        else if (chartType === "step") {
          const prevY = priceToY(candles[i - 1]!.close);
          ctx.lineTo(x, prevY);
          ctx.lineTo(x, y);
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (chartType === "line_markers") {
        ctx.fillStyle = sym.upColor;
        for (let i = 0; i < candles.length; i++) {
          ctx.beginPath();
          ctx.arc(xAt(i), priceToY(candles[i]!.close), 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (chartType === "area") {
      const grad = ctx.createLinearGradient(0, 0, 0, priceAreaH);
      grad.addColorStop(0, hexToRgba(sym.upColor, 0.4));
      grad.addColorStop(1, hexToRgba(sym.upColor, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xAt(0), priceAreaH);
      for (let i = 0; i < candles.length; i++) ctx.lineTo(xAt(i), priceToY(candles[i]!.close));
      ctx.lineTo(xAt(candles.length - 1), priceAreaH);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = sym.upColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < candles.length; i++) {
        const x = xAt(i);
        const y = priceToY(candles[i]!.close);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (chartType === "hlc_area") {
      const grad = ctx.createLinearGradient(0, 0, 0, priceAreaH);
      grad.addColorStop(0, hexToRgba(sym.upColor, 0.35));
      grad.addColorStop(1, hexToRgba(sym.downColor, 0.35));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xAt(0), priceToY(candles[0]!.high));
      for (let i = 1; i < candles.length; i++) ctx.lineTo(xAt(i), priceToY(candles[i]!.high));
      for (let i = candles.length - 1; i >= 0; i--) ctx.lineTo(xAt(i), priceToY(candles[i]!.low));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = sym.upColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < candles.length; i++) {
        const x = xAt(i);
        const y = priceToY(candles[i]!.close);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (chartType === "baseline") {
      const closes = candles.map((c) => c.close);
      const baseline = closes.reduce((a, b) => a + b, 0) / closes.length;
      const baseY = priceToY(baseline);
      // Above baseline (green fill)
      ctx.fillStyle = hexToRgba(sym.upColor, 0.25);
      ctx.beginPath();
      ctx.moveTo(xAt(0), baseY);
      for (let i = 0; i < candles.length; i++) {
        const y = priceToY(candles[i]!.close);
        ctx.lineTo(xAt(i), Math.min(y, baseY));
      }
      ctx.lineTo(xAt(candles.length - 1), baseY);
      ctx.closePath();
      ctx.fill();
      // Below baseline (red fill)
      ctx.fillStyle = hexToRgba(sym.downColor, 0.25);
      ctx.beginPath();
      ctx.moveTo(xAt(0), baseY);
      for (let i = 0; i < candles.length; i++) {
        const y = priceToY(candles[i]!.close);
        ctx.lineTo(xAt(i), Math.max(y, baseY));
      }
      ctx.lineTo(xAt(candles.length - 1), baseY);
      ctx.closePath();
      ctx.fill();
      // Close line + baseline
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      ctx.lineTo(chartW, baseY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = sym.upColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < candles.length; i++) {
        const x = xAt(i);
        const y = priceToY(candles[i]!.close);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (chartType === "columns") {
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        const isGreen = c.close >= c.open;
        ctx.fillStyle = isGreen ? sym.upColor : sym.downColor;
        const top = priceToY(Math.max(c.open, c.close));
        const bot = priceToY(Math.min(c.open, c.close));
        ctx.fillRect(xAt(i) - candleWidth / 2, top, candleWidth, Math.max(1, bot - top));
      }
    } else if (chartType === "high_low") {
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        const isGreen = c.close >= c.open;
        ctx.strokeStyle = isGreen ? sym.upColor : sym.downColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xAt(i), priceToY(c.high));
        ctx.lineTo(xAt(i), priceToY(c.low));
        ctx.stroke();
      }
    }

    // ============ STATUS LINE OHLCV (top-left) ============
    {
      const sl = cs.statusLine;
      let hoverIdx = candles.length - 1;
      // chartRuntimeRegressionFixV1: use only live mouse hover for status-line
      // candle selection. Parked touch crosshair remains visible below, but it
      // no longer makes zooming change the top current OHLC/volume display.
      const hp = hoverRef.current;
      if (hp && hp.x > 0 && hp.x < chartW && hp.y > 0 && hp.y < chartH) {
        hoverIdx = Math.max(0, Math.min(candles.length - 1, Math.floor((hp.x - 5) / candleSpacing)));
      }
      const hc = candles[hoverIdx];
      if (hc && (sl.chartValues || sl.barChangeValues || sl.volume || sl.lastDayChangeValues)) {
        const isUp = hc.close >= hc.open;
        const pos = isUp ? sym.upColor : sym.downColor;
        const fontSize = 11;
        ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "left";
        let tx = 12;
        const ty = 18;
        const draw = (label: string, val: string, color: string) => {
          ctx.fillStyle = "rgba(160,175,210,0.55)";
          ctx.fillText(label, tx, ty);
          tx += ctx.measureText(label).width + 4;
          ctx.fillStyle = color;
          ctx.fillText(val, tx, ty);
          tx += ctx.measureText(val).width + 10;
        };
        const fmt = (v: number) => formatPrice(v, cs.symbol.precision);
        if (sl.chartValues) {
          draw("O", fmt(hc.open), pos);
          draw("H", fmt(hc.high), pos);
          draw("L", fmt(hc.low), pos);
          draw("C", fmt(hc.close), pos);
        }
        if (sl.barChangeValues) {
          const diff = hc.close - hc.open;
          const pct = (diff / hc.open) * 100;
          const sign = diff >= 0 ? "+" : "";
          draw("", `${sign}${fmt(diff)} (${sign}${pct.toFixed(2)}%)`, pos);
        }
        if (sl.volume && (hc as any).volume != null) {
          const v = (hc as any).volume as number;
          const vstr = v >= 1e9 ? `${(v/1e9).toFixed(2)}B`
            : v >= 1e6 ? `${(v/1e6).toFixed(2)}M`
            : v >= 1e3 ? `${(v/1e3).toFixed(1)}K` : v.toFixed(0);
          draw("Vol", vstr, "rgba(180,190,210,0.7)");
        }
        if (sl.lastDayChangeValues && candles.length >= 2) {
          const prev = candles[Math.max(0, hoverIdx - 1)]!;
          const diff = hc.close - prev.close;
          const pct = (diff / prev.close) * 100;
          const sign = diff >= 0 ? "+" : "";
          const c = diff >= 0 ? sym.upColor : sym.downColor;
          draw("Δ", `${sign}${fmt(diff)} (${sign}${pct.toFixed(2)}%)`, c);
        }
      }
    }

    // ============ OVERLAY INDICATORS (SMA / EMA / Bollinger) ============
    const overlayInds = cs.indicators.filter((ind) => ind.pane === "overlay" && ind.visible !== false);
    if (overlayInds.length > 0) {
      const closes = candles.map((c) => c.close);
      const drawSeries = (vals: (number | null)[], color: string, lw = 1.5) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (v == null) { started = false; continue; }
          const x = xAt(i);
          const y = priceToY(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      for (const ind of overlayInds) {
        if (ind.type === "sma") drawSeries(computeSMA(closes, ind.params.length ?? 50), ind.color);
        else if (ind.type === "ema") drawSeries(computeEMA(closes, ind.params.length ?? 20), ind.color);
        else if (ind.type === "fib_grid" || ind.type === "fib_retracement") {
          const lookback = ind.params.lookback ?? 200;
          const swing = findSwingHighLow(candles, lookback);
          if (swing) {
            const seq = ind.type === "fib_grid"
              ? parseFibLevels("0|1|2|3|5|8|13|21|34|55|89")
              : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            const props = ind.type === "fib_grid" ? fibSequenceToProportions(seq) : seq;
            const range = swing.hi - swing.lo;
            const swingStartX = xAt(Math.min(swing.hiIdx, swing.loIdx));
            ctx.save();
            ctx.lineWidth = ind.type === "fib_retracement" ? 1 : 1.2;
            for (let li = 0; li < props.length; li++) {
              const p = props[li]!;
              const price = swing.lo + p * range;
              const y = priceToY(price);
              const alpha = ind.type === "fib_grid" ? 0.4 + 0.5 * (li / Math.max(1, props.length - 1)) : 0.65;
              ctx.strokeStyle = hexToRgba(ind.color, alpha);
              ctx.setLineDash(ind.type === "fib_retracement" ? [] : [4, 3]);
              ctx.beginPath();
              ctx.moveTo(Math.max(0, swingStartX), y);
              ctx.lineTo(chartW, y);
              ctx.stroke();
              // Label
              ctx.setLineDash([]);
              ctx.fillStyle = hexToRgba(ind.color, Math.min(1, alpha + 0.2));
              ctx.font = "10px 'JetBrains Mono', monospace";
              ctx.textAlign = "left";
              const label = ind.type === "fib_grid" ? `${seq[li]}` : `${(seq[li]! * 100).toFixed(1)}%`;
              ctx.fillText(label, 4, y - 2);
            }
            ctx.setLineDash([]);
            ctx.restore();
          }
        } else if (ind.type === "liq_heatmap" || ind.type === "liq_heatmap_light") {
          const leverages = [
            ind.params.lev1 ?? 5,
            ind.params.lev2 ?? 20,
            ind.params.lev3 ?? 100,
          ].filter((l) => l > 0);
          const buffer = ind.params.buffer ?? 0.5;
          const bins = 120;
          const liqBins = computeLiquidationBins(candles, leverages, buffer / 100, bins, minPrice, maxPrice);
          const maxDensity = liqBins.reduce((m, b) => Math.max(m, b.longDensity, b.shortDensity), 0);
          if (maxDensity > 0) {
            const baseAlpha = ind.type === "liq_heatmap" ? 0.55 : 0.22;
            const binH = priceAreaH / bins;
            for (let bi = 0; bi < liqBins.length; bi++) {
              const b = liqBins[bi]!;
              const total = b.longDensity + b.shortDensity;
              if (total === 0) continue;
              const intensity = total / maxDensity;
              const dominantUp = b.shortDensity > b.longDensity; // shorts liq above → bullish squeeze magnet
              const baseColor = dominantUp ? sym.upColor : sym.downColor;
              const yTop = priceAreaH - (bi + 1) * binH;
              ctx.fillStyle = hexToRgba(baseColor, baseAlpha * intensity);
              ctx.fillRect(0, yTop, chartW, binH + 0.5);
            }
          }
        } else if (ind.type === "liq_heatmap_real") {
          // Real, executed liquidation volume from exchange feeds (OKX +
          // Hyperliquid). Pulled from /liquidity/liquidations/clusters,
          // which buckets recent liquidations by price band. Each band is
          // drawn as a horizontal stripe whose color reflects long/short
          // tilt and whose alpha scales with that band's USD volume.
          const clusters = realLiqClustersRef.current;
          if (clusters.length > 0) {
            const maxUsd = clusters.reduce((m, c) => Math.max(m, c.totalUsd), 0);
            if (maxUsd > 0) {
              ctx.save();
              for (const c of clusters) {
                if (!Number.isFinite(c.bucketLow) || !Number.isFinite(c.bucketHigh)) continue;
                if (c.bucketHigh < minPrice || c.bucketLow > maxPrice) continue;
                const yHi = priceToY(Math.min(c.bucketHigh, maxPrice));
                const yLo = priceToY(Math.max(c.bucketLow, minPrice));
                const yTop = Math.min(yHi, yLo);
                const bandH = Math.max(1, Math.abs(yLo - yHi));
                const intensity = c.totalUsd / maxUsd;
                // Long-heavy band ⇒ longs got liquidated below price ⇒
                // downside event, render with downColor. Short-heavy ⇒
                // upside squeeze, render with upColor.
                const longTilt = c.totalUsd > 0 ? c.longUsd / c.totalUsd : 0.5;
                const baseColor = longTilt >= 0.5 ? sym.downColor : sym.upColor;
                ctx.fillStyle = hexToRgba(baseColor, 0.15 + intensity * 0.55);
                ctx.fillRect(0, yTop, chartW, bandH);
              }
              ctx.restore();
            }
          }
        }
        else if (ind.type === "absorption_levels") {
          const left = Math.max(1, Math.floor(ind.params.pivotLeft ?? 3));
          const right = Math.max(1, Math.floor(ind.params.pivotRight ?? 3));
          const seedLines = Math.max(2, Math.floor(ind.params.seedLines ?? 12));
          const mergeSteps = Math.max(1, Math.floor(ind.params.mergeDistanceSteps ?? 3));
          const groupStep = Math.max(1e-8, ind.params.groupStep ?? 5);
          const showLabels = (ind.params.showLabels ?? 1) > 0;
          const mergeDist = mergeSteps * groupStep;
          const bullColor = "#10b981";
          const bearColor = "#ef4444";

          interface Pivot { side: "bull" | "bear"; price: number; score: number; touches: number; }
          const candidates: Pivot[] = [];
          for (let i = left; i < candles.length - right; i++) {
            const c = candles[i]!;
            let isHigh = true, isLow = true;
            for (let j = i - left; j <= i + right; j++) {
              if (j === i || j < 0 || j >= candles.length) continue;
              if (candles[j]!.high >= c.high) isHigh = false;
              if (candles[j]!.low <= c.low) isLow = false;
              if (!isHigh && !isLow) break;
            }
            if (isLow) candidates.push({ side: "bull", price: c.low, score: 1, touches: 1 });
            if (isHigh) candidates.push({ side: "bear", price: c.high, score: 1, touches: 1 });
          }

          const grouped: Pivot[] = [];
          const sorted = [...candidates].sort((a, b) => a.price - b.price || b.score - a.score);
          for (const p of sorted) {
            const ex = grouped.find((g) => g.side === p.side && Math.abs(g.price - p.price) <= mergeDist);
            if (!ex) {
              grouped.push({ ...p });
            } else {
              const total = ex.score + p.score;
              ex.price = (ex.price * ex.score + p.price * p.score) / total;
              ex.score = total;
              ex.touches += 1;
            }
          }
          const merged = grouped.sort((a, b) => b.score - a.score).slice(0, seedLines);

          ctx.save();
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          for (const lv of merged) {
            if (lv.price < minPrice || lv.price > maxPrice) continue;
            const y = Math.round(priceToY(lv.price)) + 0.5;
            const color = lv.side === "bull" ? bullColor : bearColor;
            ctx.strokeStyle = hexToRgba(color, 0.7);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartW, y);
            ctx.stroke();
            if (showLabels) {
              ctx.setLineDash([]);
              const tag = `${lv.side === "bull" ? "Rev S" : "Rev R"} ${lv.touches > 1 ? `×${lv.touches}` : ""}`.trim();
              ctx.font = "9px 'JetBrains Mono', monospace";
              ctx.fillStyle = hexToRgba(color, 0.85);
              ctx.textAlign = "left";
              ctx.fillText(tag, 4, y - 2);
              ctx.setLineDash([4, 3]);
            }
          }
          ctx.setLineDash([]);
          ctx.restore();
        }
        else if (ind.type === "bb") {
          const bb = computeBollingerBands(closes, ind.params.length ?? 20, ind.params.mult ?? 2);
          drawSeries(bb.upper, ind.color, 1);
          drawSeries(bb.lower, ind.color, 1);
          drawSeries(bb.mid, hexToRgba(ind.color, 0.6), 1);
          // Faint band fill
          ctx.fillStyle = hexToRgba(ind.color, 0.06);
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < bb.upper.length; i++) {
            const u = bb.upper[i];
            if (u == null) continue;
            const x = xAt(i);
            const y = priceToY(u);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          for (let i = bb.lower.length - 1; i >= 0; i--) {
            const l = bb.lower[i];
            if (l == null) continue;
            ctx.lineTo(xAt(i), priceToY(l));
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // ============ STRUCTURAL LEVELS OVERLAY (statistical, optional) ============
    {
      const szones = confluenceVisibleZones ?? structuralZonesRef.current;
      if (szones && szones.length > 0) {
        const showLbl = structuralLabelsRef.current;
        const fillMul = Math.max(0, Math.min(1, structuralFillOpacityRef.current));
        // Display-only style for structural lines. Defaults preserve the
        // engine's native dash patterns ([5,4] mid, [2,3] edges) and the
        // confidence-tier hue mapping. These do NOT touch engine math.
        const slStyleCfg: any = settingsRef.current.structuralLevels ?? {};
        const slLineStyle = (slStyleCfg.lineStyle ?? "default") as OverlayLineStyle;
        const slPalette = (slStyleCfg.colorPalette ?? "default") as OverlayColorPalette;
        const slLineWidthMul = Math.max(0.5, Math.min(3, slStyleCfg.lineWidthMultiplier ?? 1));
        const userMidDash = overlayLineDash(slLineStyle); // null when "default"
        // For band edges we want a slightly tighter dash than the mid-line
        // so visual hierarchy reads. When the user picks an explicit style,
        // reuse the same array (visual consistency); when "default", keep
        // the engine's [2,3] edge dash exactly as before.
        const userEdgeDash = userMidDash;
        // Keep structural labels readable on dense/mobile charts without
        // removing the actual zones. Bands/lines always render; only labels
        // collapse to a tiny right-edge tick when they would overlap.
        const structuralLabelYs: number[] = [];
        const structuralLabelMinGap = chartW < 640 ? 16 : 12;
        ctx.save();
        ctx.lineWidth = 1.25 * slLineWidthMul;
        for (const z of szones) {
          const lo = Math.max(z.priceLow, minPrice);
          const hi = Math.min(z.priceHigh, maxPrice);
          if (hi < minPrice || lo > maxPrice) continue;
          const yHi = priceToY(hi);
          const yLo = priceToY(lo);
          const yTop = Math.min(yHi, yLo);
          const bandH = Math.max(1, Math.abs(yLo - yHi));
          const { stroke, fill } = structuralZoneColor(z);
          // Display-only palette tint for stroke. Fills (the band shading)
          // stay confidence-tier-driven so structural remains the visually
          // primary layer and confluence overlap stays easy to read.
          const paletteRgb = paletteColorFor(slPalette, z.kind === "support");
          const strokeColor = paletteRgb
            ? `rgb(${paletteRgb.r},${paletteRgb.g},${paletteRgb.b})`
            : stroke;
          const confluenceLines = lines.filter(
            (l) =>
              l.price >= z.priceLow &&
              l.price <= z.priceHigh &&
              sideMatchesZone(l.isBid, z.kind),
          );
          const hasLiquidityConfluence = confluenceLines.length > 0;
          // Filled band (apply user fill multiplier on top of base fill alpha).
          const m = fill.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
          if (m) {
            const [r, g, b, a] = [m[1], m[2], m[3], parseFloat(m[4]!) * fillMul];
            ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
          } else {
            ctx.fillStyle = fill;
          }
          // LOW-confidence zones are dimmed so HIGH/MEDIUM read first.
          const dim = z.confidence === "low";
          if (dim) ctx.globalAlpha = 0.45;
          ctx.fillRect(0, yTop, chartW, bandH);
          if (hasLiquidityConfluence) {
            // Thin accent bar so structural/liquidity overlap reads quickly
            // without adding a second competing signal layer.
            ctx.fillStyle = strokeColor;
            ctx.fillRect(0, yTop, 3, bandH);
          }
          // Dashed mid-line and band edges. User's "default" preserves the
          // existing engine dash pattern; explicit style overrides it.
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = (hasLiquidityConfluence ? 1.5 : 1.25) * slLineWidthMul;
          ctx.setLineDash(userMidDash ?? [5, 4]);
          // Engine zone shape may omit midPrice (it's computed at the boundary)
          // — fall back to the geometric center of the band.
          const zMid = z.midPrice ?? (z.priceLow + z.priceHigh) / 2;
          const yMid = Math.round(priceToY(zMid)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, yMid);
          ctx.lineTo(chartW, yMid);
          ctx.stroke();
          ctx.setLineDash(userEdgeDash ?? [2, 3]);
          const yTopLine = Math.round(yTop) + 0.5;
          const yBotLine = Math.round(yTop + bandH) - 0.5;
          ctx.beginPath();
          ctx.moveTo(0, yTopLine);
          ctx.lineTo(chartW, yTopLine);
          ctx.moveTo(0, yBotLine);
          ctx.lineTo(chartW, yBotLine);
          ctx.stroke();
          ctx.setLineDash([]);
          // Precise entry marker — thin solid line inside the band at the
          // statistically-picked entry price. Skipped when out of range or
          // when the picker degraded to the midpoint (already drawn above).
          if (
            typeof z.preciseEntryPrice === "number" &&
            Number.isFinite(z.preciseEntryPrice) &&
            z.preciseEntryPrice >= minPrice &&
            z.preciseEntryPrice <= maxPrice &&
            Math.abs(z.preciseEntryPrice - zMid) > 1e-9
          ) {
            const yEntry = Math.round(priceToY(z.preciseEntryPrice)) + 0.5;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 1.5 * slLineWidthMul;
            ctx.beginPath();
            ctx.moveTo(0, yEntry);
            ctx.lineTo(chartW, yEntry);
            ctx.stroke();
            ctx.lineWidth = (hasLiquidityConfluence ? 1.5 : 1.25) * slLineWidthMul;
          }
          if (showLbl) {
            const conf = z.confidence === "high" ? "H" : z.confidence === "medium" ? "M" : "L";
            const kind = z.kind === "support" ? "S" : z.kind === "resistance" ? "R" : "·";
            const br = z.bounceRate != null ? `${Math.round(z.bounceRate * 100)}%` : "—";
            const xa = z.crossAssetConfirmed ? " ✕" : "";
            const tag = `${hasLiquidityConfluence ? "◆ " : ""}SL·${kind}·${conf} ${br}${z.confirmed ? " ✓" : ""}${xa}`;
            const labelY = yMid - 3;
            const labelCollides = structuralLabelYs.some((y) => Math.abs(y - labelY) < structuralLabelMinGap);
            ctx.fillStyle = stroke;
            if (!labelCollides) {
              structuralLabelYs.push(labelY);
              ctx.font = "9px 'JetBrains Mono', monospace";
              ctx.textAlign = "right";
              ctx.fillText(tag, chartW - 6, labelY);
              ctx.textAlign = "left";
            } else {
              // Preserve positional awareness for crowded zones without
              // painting unreadable overlapping text.
              ctx.globalAlpha *= 0.75;
              ctx.fillRect(chartW - 5, yMid - 1, 5, 2);
              ctx.globalAlpha /= 0.75;
            }
          }
          if (dim) ctx.globalAlpha = 1;
        }
        ctx.restore();
      }
    }

    // ============ SCANNER-DRIVEN HIGHLIGHT BAND ============
    // Glowing band carried in from the level-touch scanner so the user lands
    // on the matched zone instead of having to find it. Drawn on top of the
    // structural overlay but below the current-price line and crosshair so
    // it never hides live state.
    {
      const hl = highlightRef.current;
      if (hl && Number.isFinite(hl.priceLow) && Number.isFinite(hl.priceHigh)) {
        const lo = Math.max(hl.priceLow, minPrice);
        const hi = Math.min(hl.priceHigh, maxPrice);
        if (hi >= minPrice && lo <= maxPrice) {
          const yHi = priceToY(hi);
          const yLo = priceToY(lo);
          const yTop = Math.min(yHi, yLo);
          const bandH = Math.max(2, Math.abs(yLo - yHi));
          ctx.save();
          // Keep scanner context visible without letting the band read like a
          // primary signal layer.
          ctx.fillStyle = "rgba(34, 211, 238, 0.06)";
          ctx.fillRect(0, yTop, chartW, bandH);
          ctx.strokeStyle = "rgba(34, 211, 238, 0.55)";
          ctx.lineWidth = 0.75;
          ctx.setLineDash([]);
          const yTopLine = Math.round(yTop) + 0.5;
          const yBotLine = Math.round(yTop + bandH) - 0.5;
          ctx.beginPath();
          ctx.moveTo(0, yTopLine);
          ctx.lineTo(chartW, yTopLine);
          ctx.moveTo(0, yBotLine);
          ctx.lineTo(chartW, yBotLine);
          ctx.stroke();
          // Mid line, dashed, anchored at the matched mid price when in range.
          if (
            Number.isFinite(hl.midPrice) &&
            hl.midPrice >= minPrice &&
            hl.midPrice <= maxPrice
          ) {
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = "rgba(34, 211, 238, 0.4)";
            ctx.lineWidth = 0.75;
            const yMid = Math.round(priceToY(hl.midPrice)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, yMid);
            ctx.lineTo(chartW, yMid);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          // Caption: source + kind + tf, top-left of the band.
          const labelBits: string[] = ["MATCH"];
          if (hl.source) labelBits.push(hl.source.toUpperCase());
          if (hl.kind) labelBits.push(hl.kind.toUpperCase());
          if (hl.timeframe) labelBits.push(hl.timeframe);
          const label = labelBits.join(" · ");
          ctx.font = "10px 'JetBrains Mono', monospace";
          const padX = 4;
          const padY = 2;
          const textW = Math.min(ctx.measureText(label).width, Math.max(40, chartW - padX * 2));
          const tagW = textW + padX * 2;
          const tagH = 14;
          const tagY = Math.max(0, yTop - tagH - 2);
          ctx.fillStyle = "rgba(8, 47, 73, 0.82)";
          ctx.fillRect(0, tagY, tagW, tagH);
          ctx.strokeStyle = "rgba(34, 211, 238, 0.55)";
          ctx.lineWidth = 0.75;
          ctx.strokeRect(0.5, tagY + 0.5, tagW - 1, tagH - 1);
          ctx.fillStyle = "rgba(165, 243, 252, 0.88)";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          const renderedLabel = ctx.measureText(label).width > textW ? `${label.slice(0, Math.max(4, Math.floor(textW / 7) - 1))}…` : label;
          ctx.fillText(renderedLabel, padX, tagY + tagH / 2 + padY / 2);
          ctx.textBaseline = "alphabetic";
          ctx.restore();
        }
      }
    }

    // ============ ANALYTICS OVERLAYS (T003) ============
    // Five independently-toggleable overlays, all sourced from real exchange
    // data via /liquidity/analytics. Drawn into the same canvas as the price
    // pane so they pan/zoom with everything else.
    {
      const ov = overlayCfgRef.current;
      const a = analyticsRef.current;
      const STRIP_TOP_Y = 0;
      let stripCursorY = STRIP_TOP_Y;

      // ─── Magnet zones: liquidation cluster bands across the price pane ───
      if (ov.magnetZones && magnetsRef.current.length > 0 && renderData.markPrice > 0) {
        const clusters = magnetsRef.current;
        const maxUsd = Math.max(...clusters.map((c) => c.totalUsd));
        ctx.save();
        for (const c of clusters) {
          if (!Number.isFinite(c.bucketLow) || !Number.isFinite(c.bucketHigh)) continue;
          if (c.bucketHigh < minPrice || c.bucketLow > maxPrice) continue;
          const yHi = priceToY(Math.min(c.bucketHigh, maxPrice));
          const yLo = priceToY(Math.max(c.bucketLow, minPrice));
          const yTop = Math.min(yHi, yLo);
          const bandH = Math.max(2, Math.abs(yLo - yHi));
          const intensity = maxUsd > 0 ? c.totalUsd / maxUsd : 0;
          // Color by long/short tilt: long-heavy = red (downside magnet),
          // short-heavy = green (upside magnet). Alpha scales with intensity.
          const longTilt = c.totalUsd > 0 ? c.longUsd / c.totalUsd : 0.5;
          const r = Math.round(239 * longTilt + 34 * (1 - longTilt));
          const g = Math.round(68 * longTilt + 197 * (1 - longTilt));
          const b = Math.round(68 * longTilt + 94 * (1 - longTilt));
          const baseAlpha = 0.10 + intensity * 0.25;
          ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha})`;
          ctx.fillRect(0, yTop, chartW, bandH);
          // Inner halo line at bucket midpoint.
          const yMid = priceToY(c.bucketPrice);
          ctx.strokeStyle = `rgba(${r},${g},${b},${0.45 + intensity * 0.4})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 5]);
          ctx.beginPath();
          ctx.moveTo(0, Math.round(yMid) + 0.5);
          ctx.lineTo(chartW, Math.round(yMid) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // ─── Funding-rate divergence strip (top of price pane) ───
      if (ov.funding && a?.funding) {
        const stripH = 16;
        const z = a.funding.zScore;
        const rate = a.funding.current;
        // Colormap: positive z = red (longs paying shorts, longs over-leveraged
        // → fade-the-rally signal). Negative z = green. Saturation peaks at |z|=2.
        let bg = "rgba(120,128,160,0.18)";
        if (z !== null && Number.isFinite(z)) {
          const sat = Math.min(1, Math.abs(z) / 2);
          if (z > 0) bg = `rgba(239, 68, 68, ${0.15 + sat * 0.45})`;
          else bg = `rgba(34, 197, 94, ${0.15 + sat * 0.45})`;
        }
        ctx.fillStyle = bg;
        ctx.fillRect(0, stripCursorY, chartW, stripH);
        // Mini sparkline of the funding rate over the visible window.
        const fs = a.funding.samples;
        if (fs.length > 1) {
          const minR = Math.min(...fs.map((s) => s.rate));
          const maxR = Math.max(...fs.map((s) => s.rate));
          const range = maxR - minR || 1e-9;
          ctx.strokeStyle = "rgba(255,255,255,0.7)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < fs.length; i++) {
            const x = (i / (fs.length - 1)) * chartW;
            const y = stripCursorY + stripH - ((fs[i]!.rate - minR) / range) * (stripH - 2) - 1;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const rateLbl = rate !== null ? `${(rate * 100).toFixed(4)}%` : "—";
        const zLbl = z !== null ? `z=${z.toFixed(2)}` : "z=—";
        ctx.fillText(`Funding ${rateLbl}  ${zLbl}`, 6, stripCursorY + stripH / 2);
        ctx.textBaseline = "alphabetic";
        stripCursorY += stripH + 1;
      }

      // ─── OI delta heat strip (per-bucket %ΔOI as colored cells) ───
      if (ov.oiDelta && a?.oiDelta?.samples?.length) {
        const stripH = 14;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(0, stripCursorY, chartW, stripH);
        const samples = a.oiDelta.samples;
        const maxAbsDelta = Math.max(
          1,
          ...samples.map((s) => (s.deltaBps !== null ? Math.abs(s.deltaBps) : 0)),
        );
        const cellW = Math.max(1, chartW / samples.length);
        for (let i = 0; i < samples.length; i++) {
          const d = samples[i]!.deltaBps;
          if (d === null) continue;
          const sat = Math.min(1, Math.abs(d) / maxAbsDelta);
          // Positive ΔOI (new positions opening) = blue; negative (positions
          // closing) = orange — mirrors the convention used by Velo/Coinglass.
          const color = d >= 0
            ? `rgba(59, 130, 246, ${0.25 + sat * 0.6})`
            : `rgba(249, 115, 22, ${0.25 + sat * 0.6})`;
          ctx.fillStyle = color;
          ctx.fillRect(i * cellW, stripCursorY + 1, Math.ceil(cellW), stripH - 2);
        }
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const oiUsd = a.oiDelta.currentUsd;
        const oiLbl = oiUsd !== null && oiUsd > 0 ? `$${(oiUsd / 1e6).toFixed(1)}M` : "—";
        ctx.fillText(`ΔOI  OI=${oiLbl}`, 6, stripCursorY + stripH / 2);
        ctx.textBaseline = "alphabetic";
        stripCursorY += stripH + 1;
      }

      // ─── Taker pressure ribbon (bottom of price pane) ───
      if (ov.takerPressure && a?.takerPressure?.samples?.length) {
        const stripH = 14;
        const ribbonY = priceAreaH - stripH - 1;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(0, ribbonY, chartW, stripH);
        const samples = a.takerPressure.samples;
        const cellW = Math.max(1, chartW / samples.length);
        for (let i = 0; i < samples.length; i++) {
          const r = samples[i]!.ratio; // -1..+1
          const sat = Math.min(1, Math.abs(r));
          const color = r >= 0
            ? `rgba(34, 197, 94, ${0.20 + sat * 0.65})`
            : `rgba(239, 68, 68, ${0.20 + sat * 0.65})`;
          ctx.fillStyle = color;
          ctx.fillRect(i * cellW, ribbonY + 1, Math.ceil(cellW), stripH - 2);
        }
        // Center line @ neutral.
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, ribbonY + stripH / 2 + 0.5);
        ctx.lineTo(chartW, ribbonY + stripH / 2 + 0.5);
        ctx.stroke();
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const ratio = a.takerPressure.currentRatio;
        const rLbl = ratio !== null ? `${(ratio * 100).toFixed(0)}%` : "—";
        ctx.fillText(`Taker ${rLbl}`, 6, ribbonY + stripH / 2);
        ctx.textBaseline = "alphabetic";
      }

      // ─── Real CVD line (overlay, scaled to a thin strip just above the taker ribbon) ───
      if (ov.cvd && a?.cvd?.samples?.length && a.cvd.samples.length > 1) {
        const stripH = 32;
        const ribbonOffset = ov.takerPressure ? 14 + 2 : 0;
        const cvdBot = priceAreaH - ribbonOffset - 2;
        const cvdTop = cvdBot - stripH;
        const samples = a.cvd.samples;
        const minV = Math.min(...samples.map((s) => s.cvdNotional));
        const maxV = Math.max(...samples.map((s) => s.cvdNotional));
        const range = maxV - minV || 1e-9;
        // Faint backing so the line stays legible over price candles.
        ctx.fillStyle = "rgba(0,0,0,0.30)";
        ctx.fillRect(0, cvdTop, chartW, stripH);
        ctx.strokeStyle = "rgba(168, 85, 247, 0.95)"; // purple
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const x = (i / (samples.length - 1)) * chartW;
          const y = cvdBot - ((samples[i]!.cvdNotional - minV) / range) * (stripH - 2) - 1;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(216, 180, 254, 0.95)";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const cvdLbl = a.cvd.latestNotional >= 0
          ? `+$${(a.cvd.latestNotional / 1e6).toFixed(2)}M`
          : `-$${(Math.abs(a.cvd.latestNotional) / 1e6).toFixed(2)}M`;
        ctx.fillText(`CVD ${cvdLbl}`, 6, cvdTop + 2);
        ctx.textBaseline = "alphabetic";
      }
    }

    // ============ CURRENT PRICE LINE ============
    const currentY = priceToY(renderData.markPrice);
    const symStyle = cs.scalesAndLines.symbolLabelStyle;
    if (symStyle === "value_line" || symStyle === "label_line") {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = cs.scalesAndLines.symbolLabelColor || "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(currentY) + 0.5);
      ctx.lineTo(chartW, Math.round(currentY) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // ============ SUB-PANE INDICATORS (RSI / MACD / Volume) ============
    if (subPaneIndicators.length > 0) {
      const closes = candles.map((c) => c.close);
      const paneTextColor = cs.canvas.scalesTextColor || "rgba(160,175,210,0.55)";
      const paneFontSize = Math.max(9, (cs.canvas.scalesTextSize || 11) - 1);
      subPaneIndicators.forEach((ind, idx) => {
        const top = priceAreaH + idx * SUB_PANE_H_EACH;
        const bot = top + SUB_PANE_H_EACH;
        const innerTop = top + 4;
        const innerBot = bot - 4;
        const innerH = innerBot - innerTop;
        // Pane background + separator
        ctx.fillStyle = hexToRgba(cs.canvas.background || "#0c0c1d", 0.6);
        ctx.fillRect(0, top, chartW, SUB_PANE_H_EACH);
        ctx.strokeStyle = "rgba(160,175,210,0.1)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, top + 0.5);
        ctx.lineTo(chartW, top + 0.5);
        ctx.stroke();
        // Pane label
        ctx.fillStyle = paneTextColor;
        ctx.font = `${paneFontSize}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "left";
        const paramStr = Object.values(ind.params).join(",");
        ctx.fillText(`${ind.type.toUpperCase()}${paramStr ? ` ${paramStr}` : ""}`, 6, top + 14);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, chartW, SUB_PANE_H_EACH);
        ctx.clip();

        if (ind.type === "rsi") {
          const length = ind.params.length ?? 14;
          const rsi = computeRSI(closes, length);
          const yAt = (v: number) => innerTop + (1 - v / 100) * innerH;
          // 30/50/70 reference lines
          for (const lvl of [30, 50, 70]) {
            ctx.strokeStyle = lvl === 50 ? "rgba(160,175,210,0.15)" : "rgba(160,175,210,0.25)";
            ctx.setLineDash(lvl === 50 ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(0, yAt(lvl));
            ctx.lineTo(chartW, yAt(lvl));
            ctx.stroke();
          }
          ctx.setLineDash([]);
          // RSI line
          ctx.strokeStyle = ind.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < rsi.length; i++) {
            const v = rsi[i];
            if (v == null) { started = false; continue; }
            const x = xAt(i);
            const y = yAt(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else if (ind.type === "macd") {
          const { macd, signal, hist } = computeMACD(
            closes,
            ind.params.fast ?? 12,
            ind.params.slow ?? 26,
            ind.params.signal ?? 9
          );
          const allVals: number[] = [];
          for (const arr of [macd, signal, hist]) for (const v of arr) if (v != null) allVals.push(v);
          if (allVals.length > 0) {
          const maxAbs = Math.max(...allVals.map(Math.abs)) || 1;
          const yAt = (v: number) => innerTop + innerH / 2 - (v / maxAbs) * (innerH / 2 - 2);
          const zeroY = yAt(0);
          // Histogram
          const barW = Math.max(1, candleSpacing * 0.6);
          for (let i = 0; i < hist.length; i++) {
            const h = hist[i];
            if (h == null) continue;
            const y = yAt(h);
            ctx.fillStyle = h >= 0 ? hexToRgba(sym.upColor, 0.6) : hexToRgba(sym.downColor, 0.6);
            ctx.fillRect(xAt(i) - barW / 2, Math.min(y, zeroY), barW, Math.abs(y - zeroY));
          }
          // Zero line
          ctx.strokeStyle = "rgba(160,175,210,0.2)";
          ctx.beginPath();
          ctx.moveTo(0, zeroY);
          ctx.lineTo(chartW, zeroY);
          ctx.stroke();
          // MACD + Signal
          const drawLine = (arr: (number | null)[], color: string) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            let st = false;
            for (let i = 0; i < arr.length; i++) {
              const v = arr[i];
              if (v == null) { st = false; continue; }
              const x = xAt(i), y = yAt(v);
              if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
          };
          drawLine(macd, ind.color);
          drawLine(signal, "#f59e0b");
          }
        } else if (ind.type === "volume") {
          const vols: number[] = [];
          for (let i = 0; i < candles.length; i++) {
            vols.push(candleVolume(candles[i]!));
          }
          const maxV = Math.max(...vols, 1);
          const barW = Math.max(1, candleSpacing * 0.7);
          for (let i = 0; i < vols.length; i++) {
            const c = candles[i]!;
            const isGreen = c.close >= c.open;
            const h = (vols[i]! / maxV) * (innerH - 6);
            ctx.fillStyle = hexToRgba(isGreen ? sym.upColor : sym.downColor, 0.6);
            ctx.fillRect(xAt(i) - barW / 2, innerBot - h, barW, h);
          }
        } else if (ind.type === "volume_delta") {
          // Volume bars colored by direction + small delta marker
          const vols: number[] = [];
          const deltas: number[] = [];
          for (let i = 0; i < candles.length; i++) {
            const c = candles[i]!;
            const v = candleVolume(c);
            const { buy, sell } = tickRuleDelta(c, v);
            vols.push(v);
            deltas.push(buy - sell);
          }
          const maxV = Math.max(...vols, 1);
          const maxAbsD = Math.max(...deltas.map(Math.abs), 1);
          const barW = Math.max(1, candleSpacing * 0.7);
          const dW = Math.max(1, candleSpacing * 0.25);
          for (let i = 0; i < vols.length; i++) {
            const c = candles[i]!;
            const isGreen = c.close >= c.open;
            const h = (vols[i]! / maxV) * (innerH * 0.7 - 4);
            ctx.fillStyle = hexToRgba(isGreen ? sym.upColor : sym.downColor, 0.45);
            ctx.fillRect(xAt(i) - barW / 2, innerBot - h, barW, h);
            // Delta marker stacked on top, scaled to remaining 30%
            const dh = (Math.abs(deltas[i]!) / maxAbsD) * (innerH * 0.25);
            ctx.fillStyle = deltas[i]! >= 0 ? sym.upColor : sym.downColor;
            ctx.fillRect(xAt(i) - dW / 2, innerBot - h - dh, dW, dh);
          }
        } else if (ind.type === "cvd" || ind.type === "cvd_perp") {
          const cvd = computeCVD(candles);
          if (cvd.length > 0) {
            const minV = Math.min(...cvd);
            const maxV = Math.max(...cvd);
            const range = maxV - minV || 1;
            const yAt = (v: number) => innerTop + (1 - (v - minV) / range) * innerH;
            // Zero line if it falls inside the range
            if (minV <= 0 && maxV >= 0) {
              ctx.strokeStyle = "rgba(160,175,210,0.2)";
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              const zy = yAt(0);
              ctx.moveTo(0, zy);
              ctx.lineTo(chartW, zy);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            // Filled area under the line
            ctx.fillStyle = hexToRgba(ind.color, 0.18);
            ctx.beginPath();
            ctx.moveTo(xAt(0), innerBot);
            for (let i = 0; i < cvd.length; i++) ctx.lineTo(xAt(i), yAt(cvd[i]!));
            ctx.lineTo(xAt(cvd.length - 1), innerBot);
            ctx.closePath();
            ctx.fill();
            // Line
            ctx.strokeStyle = ind.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < cvd.length; i++) {
              const x = xAt(i), y = yAt(cvd[i]!);
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      });
    }

    // ============ PRICE AXIS ============
    ctx.fillStyle = cs.canvas.background || "#0c0c1d";
    ctx.fillRect(chartW, 0, PRICE_AXIS_W, priceAreaH);

    if (cs.scalesAndLines.currencyAndUnit !== "hidden") {
      ctx.fillStyle = cs.canvas.scalesTextColor || "rgba(160,175,210,0.55)";
      ctx.font = `${cs.canvas.scalesTextSize || 11}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "left";
      for (let p = gridStart; p <= maxPrice; p += gridStep) {
        const y = priceToY(p);
        if (y < 10 || y > priceAreaH - 5) continue;
        ctx.fillText(formatPrice(p, cs.symbol.precision), chartW + 8, y + 4);
      }
    }

    // Axis divider lines (scalesLineColor)
    ctx.strokeStyle = cs.canvas.scalesLineColor || "rgba(160,175,210,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartW + 0.5, 0);
    ctx.lineTo(chartW + 0.5, chartH);
    ctx.moveTo(0, chartH + 0.5);
    ctx.lineTo(W, chartH + 0.5);
    ctx.stroke();

    const eliteLines = lines.filter((l) => l.tier === "elite");
    const strongLines = lines.filter((l) => l.tier === "strong");
    const badgeCap = Math.max(0, Math.floor(liqCfg.maxBadges));
    const topLines = [...eliteLines, ...strongLines].slice(0, badgeCap);

    for (const line of topLines) {
      const y = priceToY(line.price);
      if (y < 8 || y > priceAreaH - 8) continue;

      const baseColor = lineColor(line.strength, line.isBid);
      const override = line.isBid ? supportOverride : resistanceOverride;
      // Display-only palette tint: applied only when the user has NOT set
      // an explicit support/resistance color (those still take precedence)
      // and only when palette !== "default" (default returns null and
      // preserves the existing strength-based hue exactly).
      const paletteTint = override ? null : paletteColorFor(liqCfg.colorPalette, line.isBid);
      const { r, g, b } = override ?? paletteTint ?? baseColor;
      const labelAlpha = (0.3 + line.strength * 0.5) * liqCfg.opacityMultiplier;

      ctx.strokeStyle = `rgba(${r},${g},${b},${labelAlpha * 0.6})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartW, Math.round(y) + 0.5);
      ctx.lineTo(chartW + 4, Math.round(y) + 0.5);
      ctx.stroke();
    }

    if (liqCfg.showBadges) {
      let badgesDrawn = 0;
      for (const line of eliteLines) {
        if (badgesDrawn >= badgeCap) break;
        if (line.touchCount < 3) continue;
        badgesDrawn++;
        const y = priceToY(line.price);
        if (y < 14 || y > priceAreaH - 8) continue;

        const baseColor = lineColor(line.strength, line.isBid);
        const override = line.isBid ? supportOverride : resistanceOverride;
        const { r, g, b } = override ?? baseColor;
        const labelAlpha = (0.3 + line.strength * 0.5) * liqCfg.opacityMultiplier;
        const pct = Math.round(line.winRate * 100);
        const badge = `${pct}% | ${line.touchCount}`;
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = `rgba(${r},${g},${b},${labelAlpha * 0.7})`;
        ctx.textAlign = "left";
        ctx.fillText(badge, chartW + 6, y - 6);
      }
    }

    // Current price label (hidden when symbolLabelStyle === "hidden")
    if (cs.scalesAndLines.symbolLabelStyle !== "hidden") {
      const priceStr = formatPrice(renderData.markPrice, cs.symbol.precision);
      const labelH2 = 18;
      const countdownH = cs.scalesAndLines.countdownToBarClose ? 14 : 0;
      const roomBelow = currentY + labelH2 / 2 + countdownH <= priceAreaH;
      const labelMinY = labelH2 / 2 + 1;
      const labelMaxY = roomBelow
        ? priceAreaH - labelH2 / 2 - countdownH - 1
        : priceAreaH - labelH2 / 2 - 1;
      const labelY = Math.max(labelMinY, Math.min(currentY, Math.max(labelMinY, labelMaxY)));
      ctx.fillStyle = cs.scalesAndLines.symbolLabelColor || "rgba(38, 166, 154, 0.92)";
      ctx.fillRect(chartW, labelY - labelH2 / 2, PRICE_AXIS_W, labelH2);
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${cs.canvas.scalesTextSize || 11}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "left";
      ctx.fillText(priceStr, chartW + 8, labelY + 4);

      // Countdown to bar close (small label below the price label)
      if (cs.scalesAndLines.countdownToBarClose && candles.length > 0) {
        const intervalMs = (() => {
          const last = candles[candles.length - 1]!.timestamp;
          const prev = candles[candles.length - 2]?.timestamp;
          return prev ? last - prev : 60_000;
        })();
        const now = Date.now();
        const lastTs = candles[candles.length - 1]!.timestamp;
        const nextClose = lastTs + intervalMs;
        const remaining = Math.max(0, nextClose - now);
        const mins = Math.floor(remaining / 60_000);
        const secs = Math.floor((remaining % 60_000) / 1000);
        const cdText = mins >= 60
          ? `${Math.floor(mins / 60)}h ${mins % 60}m`
          : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        const cdAbove = labelY + labelH2 / 2 + 14 > priceAreaH && labelY - labelH2 / 2 - 14 >= 0;
        const cdY = cdAbove ? labelY - labelH2 / 2 - 14 : labelY + labelH2 / 2;
        if (cdY >= 0 && cdY + 14 <= priceAreaH) {
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(chartW, cdY, PRICE_AXIS_W, 14);
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.font = `${Math.max(9, (cs.canvas.scalesTextSize || 11) - 2)}px 'JetBrains Mono', monospace`;
          ctx.textAlign = "center";
          ctx.fillText(cdText, chartW + PRICE_AXIS_W / 2, cdY + 10);
        }
      }
    }

    // ============ TIME AXIS ============
    ctx.fillStyle = cs.canvas.background || "#0c0c1d";
    ctx.fillRect(0, chartH, W, TIME_AXIS_H + LABEL_H);

    ctx.fillStyle = cs.canvas.scalesTextColor || "rgba(160,175,210,0.4)";
    ctx.font = `${Math.max(9, (cs.canvas.scalesTextSize || 11) - 1)}px 'JetBrains Mono', monospace`;
    ctx.textAlign = "center";

    const showDow = cs.scalesAndLines.dayOfWeekOnLabels;
    const fmtTime = (ts: number) => {
      if (showDow) return formatDate(ts);
      const d = new Date(ts);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    const maxTimeLabels = Math.max(2, Math.floor(chartW / (chartW < 640 ? 86 : 112)));
    const labelEvery = Math.max(1, Math.ceil(candles.length / maxTimeLabels));
    let lastTimeLabelX = -Infinity;
    for (let i = 0; i < candles.length; i += labelEvery) {
      const c = candles[i]!;
      const x = 5 + i * candleSpacing + candleSpacing / 2;
      if (x - lastTimeLabelX < (chartW < 640 ? 70 : 88)) continue;
      ctx.fillText(fmtTime(c.timestamp), x, chartH + 15);
      lastTimeLabelX = x;
    }

    // ============ CROSSHAIR ============
    {
      const hp = hoverRef.current ?? parkedRef.current;
      const isParked = !hoverRef.current && !!parkedRef.current;
      if (hp && hp.x > 0 && hp.x < chartW && hp.y > 0 && hp.y < chartH) {
        const xhairColor = cs.canvas.crosshairColor || "#a0afd2";
        const dash = cs.canvas.crosshairStyle === "solid" ? []
          : cs.canvas.crosshairStyle === "dotted" ? [1, 3]
          : [4, 3];
        ctx.strokeStyle = xhairColor;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(0, hp.y + 0.5);
        ctx.lineTo(chartW, hp.y + 0.5);
        ctx.moveTo(hp.x + 0.5, 0);
        ctx.lineTo(hp.x + 0.5, chartH);
        ctx.stroke();
        ctx.setLineDash([]);

        // price label on right axis
        const priceArea = priceAreaH;
        const scaleMode2 = cs.canvas.priceScaleMode ?? "auto";
        const yToPrice = (y: number) => {
          if (scaleMode2 === "log" && minPrice > 0) {
            const logMin = Math.log(minPrice);
            const logRange = Math.log(maxPrice) - logMin;
            return Math.exp(logMin + (1 - y / priceArea) * logRange);
          }
          return minPrice + (1 - y / priceArea) * (maxPrice - minPrice);
        };
        const hoveredPrice = yToPrice(hp.y);
        const priceText = formatPrice(hoveredPrice, cs.symbol.precision);
        ctx.fillStyle = "rgba(20,30,50,0.95)";
        ctx.fillRect(chartW, hp.y - 9, PRICE_AXIS_W, 18);
        ctx.fillStyle = "#fff";
        ctx.font = `${cs.canvas.scalesTextSize || 11}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "left";
        ctx.fillText(priceText, chartW + 8, hp.y + 4);

        // time label on bottom axis
        const idx = Math.max(0, Math.min(candles.length - 1, Math.floor((hp.x - 5) / candleSpacing)));
        const ts = candles[idx]?.timestamp;
        if (ts) {
          const d = new Date(ts);
          const tlabel = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
          ctx.font = `${Math.max(9, (cs.canvas.scalesTextSize||11)-1)}px 'JetBrains Mono', monospace`;
          const tw = ctx.measureText(tlabel).width + 12;
          ctx.fillStyle = "rgba(20,30,50,0.95)";
          ctx.fillRect(hp.x - tw/2, chartH + 2, tw, TIME_AXIS_H - 4);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.fillText(tlabel, hp.x, chartH + 16);
        }

        // ============ PARKED-TOOLTIP CALLOUT ============
        // When the crosshair is parked from a touch tap, surface the price +
        // time inside a small pill placed away from the tap point so the
        // user's finger never covers the data they tapped to read. Mirror
        // to the opposite quadrant of the chart.
        if (isParked) {
          const ts2 = candles[idx]?.timestamp;
          const dStr = ts2
            ? (() => {
                const d2 = new Date(ts2);
                return `${d2.getMonth()+1}/${d2.getDate()} ${String(d2.getHours()).padStart(2,"0")}:${String(d2.getMinutes()).padStart(2,"0")}`;
              })()
            : "";
          const lines = [priceText, dStr].filter(Boolean);
          ctx.font = "bold 12px 'JetBrains Mono', monospace";
          const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
          const padX = 8, padY = 6, lineH = 14;
          const boxW = maxW + padX * 2;
          const boxH = lines.length * lineH + padY * 2;
          // Mirror: if tap is in lower-right, draw box upper-left of tap.
          const offset = 28;
          const placeRight = hp.x < chartW / 2;
          const placeBelow = hp.y < chartH / 2;
          let bx = placeRight ? hp.x + offset : hp.x - offset - boxW;
          let by = placeBelow ? hp.y + offset : hp.y - offset - boxH;
          bx = Math.max(4, Math.min(chartW - boxW - 4, bx));
          by = Math.max(4, Math.min(chartH - boxH - 4, by));
          ctx.fillStyle = "rgba(15,22,40,0.96)";
          ctx.strokeStyle = xhairColor;
          ctx.lineWidth = 1;
          ctx.fillRect(bx, by, boxW, boxH);
          ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "left";
          for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li]!, bx + padX, by + padY + (li + 1) * lineH - 3);
          }
        }
      }
    }

    // ============ USER DRAWINGS ============
    const ds = drawingStateRef.current;
    if (!compact && !ds.hidden) {
      const drawOne = (drawing: Omit<ChartDrawing, "id" | "createdAt"> | ChartDrawing, draft = false) => {
        const pts = drawing.points;
        if (!pts.length) return;
        const xFor = (pt: DrawingPoint) => 5 + (pt.index - startIdx) * candleSpacing + candleSpacing / 2;
        const yFor = (pt: DrawingPoint) => priceToY(pt.price);
        ctx.save();
        ctx.lineWidth = draft ? 1.25 : 1.75;
        ctx.strokeStyle = draft ? "rgba(34,211,238,0.75)" : "rgba(34,211,238,0.95)";
        ctx.fillStyle = draft ? "rgba(34,211,238,0.75)" : "rgba(226,232,240,0.95)";
        ctx.font = "12px 'JetBrains Mono', monospace";
        ctx.textBaseline = "middle";
        ctx.setLineDash(draft ? [4, 4] : []);

        if (drawing.tool === "horizontal") {
          const y = Math.round(yFor(pts[0]!)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(chartW, y);
          ctx.stroke();
          ctx.fillText(formatPrice(pts[0]!.price, cs.symbol.precision), Math.max(8, chartW - 132), y - 8);
        } else if (drawing.tool === "trend" || drawing.tool === "ruler") {
          if (pts.length < 2) { ctx.restore(); return; }
          const a = pts[0]!;
          const b = pts[pts.length - 1]!;
          ctx.beginPath();
          ctx.moveTo(xFor(a), yFor(a));
          ctx.lineTo(xFor(b), yFor(b));
          ctx.stroke();
          if (drawing.tool === "ruler") {
            const pct = a.price > 0 ? ((b.price - a.price) / a.price) * 100 : 0;
            const bars = Math.abs(Math.round(b.index - a.index));
            const label = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${bars} bars`;
            const lx = (xFor(a) + xFor(b)) / 2;
            const ly = (yFor(a) + yFor(b)) / 2;
            const tw = ctx.measureText(label).width + 10;
            ctx.fillStyle = "rgba(3,7,18,0.85)";
            ctx.fillRect(lx - tw / 2, ly - 14, tw, 20);
            ctx.strokeRect(lx - tw / 2 + 0.5, ly - 14 + 0.5, tw - 1, 19);
            ctx.fillStyle = "rgba(226,232,240,0.95)";
            ctx.textAlign = "center";
            ctx.fillText(label, lx, ly - 4);
          }
        } else if (drawing.tool === "fib") {
          if (pts.length < 2) { ctx.restore(); return; }
          const a = pts[0]!;
          const b = pts[pts.length - 1]!;
          ctx.beginPath();
          ctx.moveTo(xFor(a), yFor(a));
          ctx.lineTo(xFor(b), yFor(b));
          ctx.stroke();
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          ctx.setLineDash([5, 4]);
          ctx.textAlign = "left";
          for (const r of levels) {
            const price = a.price + (b.price - a.price) * r;
            const y = Math.round(priceToY(price)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(Math.min(xFor(a), xFor(b)), y);
            ctx.lineTo(Math.max(xFor(a), xFor(b)), y);
            ctx.stroke();
            ctx.fillText(`${(r * 100).toFixed(1)}%`, Math.max(8, Math.min(xFor(a), xFor(b)) + 6), y - 7);
          }
        } else if (drawing.tool === "brush") {
          if (pts.length < 2) { ctx.restore(); return; }
          ctx.beginPath();
          ctx.moveTo(xFor(pts[0]!), yFor(pts[0]!));
          for (let i = 1; i < pts.length; i++) ctx.lineTo(xFor(pts[i]!), yFor(pts[i]!));
          ctx.stroke();
        } else if (drawing.tool === "text" || drawing.tool === "emoji") {
          const p = pts[0]!;
          ctx.textAlign = "left";
          ctx.font = drawing.tool === "emoji" ? "20px sans-serif" : "12px 'JetBrains Mono', monospace";
          ctx.fillText(drawing.text ?? (drawing.tool === "emoji" ? "⚡" : "Note"), xFor(p), yFor(p));
        }
        ctx.restore();
      };

      for (const drawing of ds.drawings) {
        if (drawing.symbol !== symbol || drawing.interval !== interval) continue;
        drawOne(drawing);
      }
      if (draftDrawingRef.current) drawOne(draftDrawingRef.current, true);
    }

    // ============ BOTTOM LABEL (status line: title + updated time) ============
    if (cs.statusLine.title) {
      ctx.fillStyle = "rgba(100,120,160,0.35)";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      const titleText =
        cs.statusLine.titleMode === "ticker"
          ? (symbol || "").toUpperCase()
          : cs.statusLine.titleMode === "description"
            ? `${(symbol || "").toUpperCase()} · LIQUIDITY HEATMAP`
            : "LIQUIDITY HEATMAP";
      ctx.fillText(titleText, 10, chartH + TIME_AXIS_H + 14);
    }

    if (cs.statusLine.openMarketStatus) {
      ctx.fillStyle = "rgba(38, 166, 154, 0.6)";
      ctx.textAlign = "right";
      const updatedTime = new Date().toLocaleTimeString();
      ctx.fillText(updatedTime, chartW - 4, chartH + TIME_AXIS_H + 14);

      ctx.fillStyle = "#26a69a";
      ctx.beginPath();
      ctx.arc(
        chartW - ctx.measureText(updatedTime).width - 10,
        chartH + TIME_AXIS_H + 10,
        3, 0, Math.PI * 2,
      );
      ctx.fill();
    }

    runChartPlugins({
      canvas,
      ctx,
      width: W,
      height: H,
      symbol: symbol || "",
      interval,
      view: {
        startIdx: viewRef.current.startIdx,
        endIdx: viewRef.current.endIdx,
        total: totalCandlesRef.current,
      },
      priceArea: { top: 0, bottom: chartH, left: 0, right: chartW },
    });
    // renderDataScopedReplacementV1
  }, [data, apiCandles, anchorCandles, interval, symbol, settings, liqSamples, compact]);

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => renderChart());
  }, [renderChart]);

  // Always reschedule a render whenever renderChart identity changes
  // (i.e. on data ticks or settings updates).
  useEffect(() => { scheduleRender(); }, [scheduleRender]);

  // Highlight is read via ref inside renderChart, so the chart needs an
  // explicit nudge whenever a new scanner-driven zone arrives or is cleared.
  useEffect(() => { scheduleRender(); }, [
    highlight?.priceLow,
    highlight?.priceHigh,
    highlight?.midPrice,
    highlight?.source,
    highlight?.kind,
    highlight?.timeframe,
    scheduleRender,
  ]);

  // Analytics overlays are read via refs inside renderChart, so kick a fresh
  // frame whenever a new tick arrives from the server or any toggle flips.
  useEffect(() => { scheduleRender(); }, [
    analyticsData,
    magnetClusters,
    realLiqClusters,
    overlayCfg.funding,
    overlayCfg.oiDelta,
    overlayCfg.takerPressure,
    overlayCfg.cvd,
    overlayCfg.magnetZones,
    scheduleRender,
  ]);

  // structuralZonesRenderNudgeV1: structural zones are read through refs inside
  // renderChart, so redraw the canvas as soon as async structural data arrives.
  useEffect(() => { scheduleRender(); }, [
    structuralZones.length,
    structuralZones[0]?.priceLow,
    structuralZones[0]?.priceHigh,
    structuralZones[0]?.score,
    structuralUnsupported,
    sl.enabled,
    sl.confluenceOnly,
    sl.minConfidence,
    sl.fillOpacity,
    scheduleRender,
  ]);

  // Mount-only: ResizeObserver and countdown timer.
  // Stable deps prevent teardown/recreate on every websocket tick — that
  // was the source of chart flicker.
  const scheduleRenderRef = useRef(scheduleRender);
  scheduleRenderRef.current = scheduleRender;
  const countdownEnabled = settings.scalesAndLines.countdownToBarClose;
  useEffect(() => {
    const container = containerRef.current;
    const ro = container ? new ResizeObserver(() => scheduleRenderRef.current()) : null;
    if (ro && container) ro.observe(container);
    const cdTimer = countdownEnabled
      ? window.setInterval(() => scheduleRenderRef.current(), 1000)
      : null;
    return () => {
      if (ro) ro.disconnect();
      if (cdTimer != null) window.clearInterval(cdTimer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [countdownEnabled]);

  // "F" hotkey: fit-to-levels toggle. Scoped to the chart so we never
  // hijack F-keystrokes elsewhere on the page — the chart must either
  // contain the focused element OR be hovered when the key is pressed.
  // Always ignored when typing into inputs/contenteditable or with a
  // modifier (Ctrl/Cmd/Alt+F still pass through to the browser).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (tgt.isContentEditable) return;
      }
      const container = containerRef.current;
      if (!container) return;
      const focusedInside =
        document.activeElement instanceof Node &&
        container.contains(document.activeElement);
      const hovered =
        typeof container.matches === "function" && container.matches(":hover");
      if (!focusedInside && !hovered) return;
      e.preventDefault();
      fitRequestRef.current = "toggle";
      scheduleRenderRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Native (non-passive) wheel handler. We cannot use React's onWheel
  // here because React 17+ attaches its synthetic wheel listener
  // passively, which means `e.preventDefault()` inside is a no-op and
  // produces the "Unable to preventDefault inside passive event
  // listener" browser warning. Without a working preventDefault the
  // page scrolls vertically every time the user zooms the chart, which
  // visibly yanks the layout. We attach this handler manually with
  // `{ passive: false }` in the useEffect below.
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    userInteractedRef.current = true;
    dismissHighlightOnInteract();
    const allLen = totalCandlesRef.current;
    if (allLen < 2) return;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // TradingView wheel behaviour:
    //   - Shift + wheel  -> pan horizontally
    //   - wheel over price axis -> scale price only
    //   - wheel over time axis  -> scale time only (anchored right edge)
    //   - wheel over chart body -> scale time, anchored to cursor X
    const overPriceAxis = localX >= rect.width - PRICE_AXIS_W;
    const overTimeAxis = localY >= rect.height - TIME_AXIS_H;

    const { startIdx, endIdx } = viewRef.current;
    const visible = endIdx - startIdx;

    // Shift + wheel pans by ~10% of the visible window per notch.
    if (e.shiftKey && !overPriceAxis) {
      const panStep = Math.max(1, Math.round(visible * 0.1));
      const dir = e.deltaY > 0 ? 1 : -1;
      let ns = startIdx + dir * panStep;
      let ne = ns + visible;
      if (ns < 0) { ns = 0; ne = visible; }
      if (ne > allLen) { ne = allLen; ns = allLen - visible; }
      viewRef.current = { startIdx: ns, endIdx: ne };
      scheduleRender();
      return;
    }

    // Price-axis wheel: scale Y only.
    // Wheel scroll on the price axis is UNBOUNDED on purpose — no hard
    // ceiling/floor. The only guard is `Number.isFinite`: if a long
    // fast scroll overflows to ±Infinity (or ever produces NaN from a
    // pathological factor), we keep the previous zoom instead of
    // poisoning the render path. Render-time price clamps (minPrice
    // >= 1% of candle low, range >= 1e-9) keep the chart drawable at
    // any finite zoom. Drag still uses V_ZOOM_MIN/V_ZOOM_MAX.
    if (overPriceAxis) {
      const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
      const next = verticalZoomRef.current * factor;
      if (Number.isFinite(next) && next > 0) {
        verticalZoomRef.current = next;
      }
      scheduleRender();
      return;
    }

    // Time-axis or chart-body wheel: scale X. Anchor depends on cursor.
    // Aggressive factor (1.6) so zoom-out feels responsive — going from the
    // default ~500 visible to the full 10k 1m budget takes ~7 wheel notches
    // instead of ~18. Zoom-in uses the inverse for symmetry.
    const factor = e.deltaY > 0 ? 1.6 : 1 / 1.6;
    let newVisible = Math.round(visible * factor);
    // +1 floor on zoom-out so rounding never traps a small visible window.
    if (e.deltaY > 0 && newVisible <= visible) newVisible = visible + 1;
    newVisible = Math.max(10, Math.min(allLen, newVisible));
    if (newVisible === visible) return;

    // Anchor the candle currently under the cursor (chart body) or at the
    // right edge (time-axis drag) — matches TradingView. Compute the
    // fractional position of the cursor over the candle area.
    const chartBodyW = Math.max(1, rect.width - PRICE_AXIS_W);
    const cursorFrac = overTimeAxis
      ? 1
      : Math.max(0, Math.min(1, localX / chartBodyW));
    const anchorIdx = startIdx + cursorFrac * visible;

    let newStart = Math.round(anchorIdx - cursorFrac * newVisible);
    let newEnd = newStart + newVisible;

    if (newStart < 0) { newStart = 0; newEnd = newVisible; }
    if (newEnd > allLen) { newEnd = allLen; newStart = allLen - newVisible; }

    viewRef.current = { startIdx: newStart, endIdx: newEnd };
    scheduleRender();
  }, [scheduleRender, PRICE_AXIS_W, TIME_AXIS_H]);

  // Attach the native wheel handler with `{ passive: false }` so
  // `e.preventDefault()` actually works. Re-attaches whenever the
  // memoized handleWheel changes so the listener never holds a stale
  // closure. We bind to the canvas (not the container) because
  // the canvas already covers the entire chart body and is the
  // surface the user wheels over.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const opts: AddEventListenerOptions = { passive: false };
    canvas.addEventListener("wheel", handleWheel, opts);
    return () => {
      canvas.removeEventListener("wheel", handleWheel, opts);
    };
  }, [handleWheel]);

  // Cancel any pending long-press timer.
  const cancelLongPress = useCallback(() => {
    if (tapRef.current?.longPressTimer != null) {
      window.clearTimeout(tapRef.current.longPressTimer);
      tapRef.current.longPressTimer = null;
    }
  }, []);

  const screenToDrawingPoint = useCallback((clientX: number, clientY: number): DrawingPoint | null => {
    const container = containerRef.current;
    const tx = plotTransformRef.current;
    if (!container || !tx) return null;
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(tx.chartW, clientX - rect.left));
    let y = Math.max(0, Math.min(tx.chartH, clientY - rect.top));
    let price = yToPriceFromTransform(tx, y);

    if (drawingStateRef.current.magnet && renderedLevelsRef.current.length > 0) {
      let best: { price: number; y: number } | null = null;
      let bestDy = Infinity;
      for (const level of renderedLevelsRef.current) {
        const dy = Math.abs(level.y - y);
        if (dy < bestDy && dy <= 12) {
          best = level;
          bestDy = dy;
        }
      }
      if (best) {
        price = best.price;
        y = best.y;
      }
    }

    const rel = Math.max(0, Math.min(1, (x - 5) / Math.max(1, tx.chartW - 10)));
    const visible = Math.max(1, tx.endIdx - tx.startIdx);
    const index = Math.max(0, Math.min(tx.total - 1, Math.round(tx.startIdx + rel * visible)));
    return { index, price };
  }, []);

  const zoomInAt = useCallback((clientX: number) => {
    const tx = plotTransformRef.current;
    const container = containerRef.current;
    const allLen = totalCandlesRef.current;
    if (!tx || !container || allLen < 2) return;
    const rect = container.getBoundingClientRect();
    const localX = clientX - rect.left;
    const visible = viewRef.current.endIdx - viewRef.current.startIdx;
    const newVisible = Math.max(10, Math.round(visible / 1.8));
    const frac = Math.max(0, Math.min(1, localX / Math.max(1, tx.chartW)));
    const anchorIdx = viewRef.current.startIdx + frac * visible;
    let newStart = Math.round(anchorIdx - frac * newVisible);
    let newEnd = newStart + newVisible;
    if (newStart < 0) { newStart = 0; newEnd = newVisible; }
    if (newEnd > allLen) { newEnd = allLen; newStart = allLen - newVisible; }
    viewRef.current = { startIdx: newStart, endIdx: newEnd };
    scheduleRenderRef.current();
  }, []);

  const handleDrawingPointerDown = useCallback((e: React.PointerEvent): boolean => {
    const ds = drawingStateRef.current;
    if (compact || ds.locked) return false;
    const tool = ds.activeTool;
    if (tool === "cursor") return false;

    e.preventDefault();
    e.stopPropagation();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}

    if (tool === "zoom") {
      zoomInAt(e.clientX);
      setActiveDrawingTool("cursor");
      return true;
    }

    if (!isDrawableTool(tool)) return false;
    const point = screenToDrawingPoint(e.clientX, e.clientY);
    if (!point) return true;

    const base = { symbol, interval, points: [point], tool };
    if (tool === "horizontal") {
      addDrawing(base);
      setActiveDrawingTool("cursor");
      scheduleRenderRef.current();
      return true;
    }
    if (tool === "text" || tool === "emoji") {
      const text = tool === "text" ? "Note" : "⚡";
      addDrawing({ ...base, text });
      setActiveDrawingTool("cursor");
      scheduleRenderRef.current();
      return true;
    }

    drawingGestureRef.current = { tool, points: [point] };
    draftDrawingRef.current = { ...base };
    scheduleRenderRef.current();
    return true;
  }, [compact, interval, screenToDrawingPoint, symbol, zoomInAt]);

  const handleDrawingPointerMove = useCallback((e: React.PointerEvent): boolean => {
    const gesture = drawingGestureRef.current;
    if (!gesture) return false;
    e.preventDefault();
    e.stopPropagation();
    const point = screenToDrawingPoint(e.clientX, e.clientY);
    if (!point) return true;
    if (gesture.tool === "brush") {
      const last = gesture.points[gesture.points.length - 1];
      if (!last || Math.abs(last.index - point.index) >= 1 || Math.abs(last.price - point.price) / Math.max(1, point.price) > 0.0005) {
        gesture.points = [...gesture.points, point].slice(-250);
      }
    } else {
      gesture.points = [gesture.points[0]!, point];
    }
    if (isDrawableTool(gesture.tool)) {
      draftDrawingRef.current = { symbol, interval, tool: gesture.tool, points: gesture.points };
    }
    scheduleRenderRef.current();
    return true;
  }, [interval, screenToDrawingPoint, symbol]);

  const handleDrawingPointerUp = useCallback((e: React.PointerEvent): boolean => {
    const gesture = drawingGestureRef.current;
    if (!gesture) return false;
    e.preventDefault();
    e.stopPropagation();
    drawingGestureRef.current = null;
    const draft = draftDrawingRef.current;
    draftDrawingRef.current = null;
    if (draft && draft.points.length >= (draft.tool === "brush" ? 2 : 2)) {
      addDrawing(draft);
    }
    setActiveDrawingTool("cursor");
    scheduleRenderRef.current();
    return true;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    userInteractedRef.current = true;
    dismissHighlightOnInteract();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (handleDrawingPointerDown(e)) return;
    const isTouch = e.pointerType === "touch";

    // Track this pointer for multi-touch detection.
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // ---- PINCH START: second finger lands ----
    if (isTouch && pointersRef.current.size === 2) {
      // Cancel any in-flight single-touch tap/long-press/pan.
      cancelLongPress();
      tapRef.current = null;
      dragRef.current.active = false;
      setIsDragging(false);
      // Dismiss parked crosshair on a new gesture.
      parkedRef.current = null;

      const pts = Array.from(pointersRef.current.values());
      const dx = pts[0]!.x - pts[1]!.x;
      const dy = pts[0]!.y - pts[1]!.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      pinchRef.current = {
        startDist: dist,
        startMidX: (pts[0]!.x + pts[1]!.x) / 2,
        startMidY: (pts[0]!.y + pts[1]!.y) / 2,
        startStartIdx: viewRef.current.startIdx,
        startVisible: viewRef.current.endIdx - viewRef.current.startIdx,
        startVZoom: verticalZoomRef.current,
      };
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
      return;
    }
    if (pointersRef.current.size > 2) return; // ignore extra fingers

    // ---- AXIS HIT-TEST (touch zones are larger so a finger can grab them) ----
    // The painted axis stays the same; only the invisible hit area grows on
    // touch input so axis-drag-to-zoom stays usable as a fallback gesture.
    const priceHit = isTouch ? PRICE_AXIS_W + 24 : PRICE_AXIS_W;
    const timeHit = isTouch ? TIME_AXIS_H + 24 : TIME_AXIS_H;
    let mode: "pan" | "yaxis" | "xaxis" = "pan";
    if (localX >= rect.width - priceHit) mode = "yaxis";
    else if (localY >= rect.height - timeHit) mode = "xaxis";

    // ---- TOUCH: classify single-finger as tap / long-press / drag ----
    if (isTouch && mode === "pan") {
      // If a parked crosshair exists, the next single tap dismisses it
      // instead of re-parking. Decided in pointerup based on movement.
      cancelLongPress();
      tapRef.current = {
        pointerId: e.pointerId,
        startTime: performance.now(),
        startX: e.clientX,
        startY: e.clientY,
        candidate: true,
        longPressTimer: window.setTimeout(() => {
          // Long-press fires only if we never started a real drag.
          if (tapRef.current && tapRef.current.candidate) {
            tapRef.current.candidate = false;
            tapRef.current.longPressTimer = null;
            parkedRef.current = null;
            dragRef.current.active = false;
            setIsDragging(false);
            openTo("symbol");
          }
        }, 500),
      };
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
      // Don't start a drag yet; wait until movement crosses threshold.
      return;
    }

    // ---- DESKTOP / AXIS DRAG (or non-touch pan) ----
    dragRef.current = {
      active: true,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origStart: viewRef.current.startIdx,
      origVisible: viewRef.current.endIdx - viewRef.current.startIdx,
      origVZoom: verticalZoomRef.current,
    };
    setIsDragging(true);
    parkedRef.current = null;
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  }, [PRICE_AXIS_W, TIME_AXIS_H, cancelLongPress, handleDrawingPointerDown, openTo]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (handleDrawingPointerMove(e)) return;
    const container = containerRef.current;
    if (!container) return;
    let drag = dragRef.current;
    const isTouch = e.pointerType === "touch";

    // Update active pointer tracking (for pinch).
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // ---- PINCH UPDATE ----
    if (pinchRef.current && pointersRef.current.size === 2) {
      const allLen = totalCandlesRef.current;
      if (allLen < 2) return;
      const pts = Array.from(pointersRef.current.values());
      const dx = pts[0]!.x - pts[1]!.x;
      const dy = pts[0]!.y - pts[1]!.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const midX = (pts[0]!.x + pts[1]!.x) / 2;
      const midY = (pts[0]!.y + pts[1]!.y) / 2;
      const p = pinchRef.current;
      // Scale time axis: spread → fewer visible bars (zoom in), pinch → more.
      const scale = p.startDist / dist; // >1 means zoom out (more bars)
      let newVisible = Math.round(p.startVisible * scale);
      newVisible = Math.max(10, Math.min(allLen, newVisible));
      // Anchor the candle under the pinch midpoint x.
      const rect = container.getBoundingClientRect();
      const chartBodyW = Math.max(1, rect.width - PRICE_AXIS_W);
      const localMidStartX = p.startMidX - rect.left;
      const cursorFrac = Math.max(0, Math.min(1, localMidStartX / chartBodyW));
      const anchorIdx = p.startStartIdx + cursorFrac * p.startVisible;
      // Two-finger pan: shift window by midpoint-x delta as well.
      const candleW = chartBodyW / Math.max(1, newVisible);
      const panShift = Math.round(-(midX - p.startMidX) / candleW);
      let newStart = Math.round(anchorIdx - cursorFrac * newVisible) + panShift;
      let newEnd = newStart + newVisible;
      if (newStart < 0) { newStart = 0; newEnd = newVisible; }
      if (newEnd > allLen) { newEnd = allLen; newStart = allLen - newVisible; }
      viewRef.current = { startIdx: newStart, endIdx: newEnd };
      // Two-finger pan also nudges price axis by midpoint-y delta.
      const dyMid = midY - p.startMidY;
      verticalZoomRef.current = Math.max(
        V_ZOOM_MIN,
        Math.min(V_ZOOM_MAX, p.startVZoom * Math.exp(-dyMid / 400)),
      );
      scheduleRender();
      return;
    }

    // ---- TOUCH TAP/LONG-PRESS THRESHOLD CHECK ----
    if (isTouch && tapRef.current && tapRef.current.pointerId === e.pointerId && tapRef.current.candidate) {
      const ddx = e.clientX - tapRef.current.startX;
      const ddy = e.clientY - tapRef.current.startY;
      if (Math.hypot(ddx, ddy) > 6) {
        // Movement threshold exceeded: cancel tap/long-press, start panning.
        cancelLongPress();
        tapRef.current.candidate = false;
        parkedRef.current = null;
        dragRef.current = {
          active: true,
          mode: "pan",
          startX: tapRef.current.startX,
          startY: tapRef.current.startY,
          origStart: viewRef.current.startIdx,
          origVisible: viewRef.current.endIdx - viewRef.current.startIdx,
          origVZoom: verticalZoomRef.current,
        };
        setIsDragging(true);
        // Re-read drag snapshot so the first move past the threshold pans
        // immediately instead of dropping a frame.
        drag = dragRef.current;
      } else {
        return; // still within tap window, do nothing
      }
    }

    if (!drag.active) {
      // Hover preview (mouse only). On touch we don't paint a hover trail
      // because the finger is the cursor — the parked tooltip is the model.
      if (!isTouch) {
        const rect = container.getBoundingClientRect();
        hoverRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        scheduleRender();
      }
      return;
    }

    const allLen = totalCandlesRef.current;
    if (allLen < 2) return;

    if (drag.mode === "yaxis") {
      // Drag down to expand price scale, up to compress (TradingView).
      // Sensitivity raised (divisor 200 -> 100) so a short drag produces
      // a bigger visual change on the chart, matching trader expectation.
      const dy = e.clientY - drag.startY;
      const factor = Math.exp(dy / 100);
      verticalZoomRef.current = Math.max(V_ZOOM_MIN, Math.min(V_ZOOM_MAX, drag.origVZoom * factor));
      scheduleRender();
      return;
    }

    if (drag.mode === "xaxis") {
      // Drag right to expand time scale (zoom out), left to compress (zoom in).
      const dx = e.clientX - drag.startX;
      const factor = Math.exp(-dx / 200);
      let newVisible = Math.round(drag.origVisible * factor);
      newVisible = Math.max(10, Math.min(allLen, newVisible));

      // Anchor to the right edge so newest candles stay visible while scaling.
      const oldEnd = drag.origStart + drag.origVisible;
      let newEnd = oldEnd;
      let newStart = newEnd - newVisible;
      if (newStart < 0) { newStart = 0; newEnd = newVisible; }
      if (newEnd > allLen) { newEnd = allLen; newStart = allLen - newVisible; }

      viewRef.current = { startIdx: newStart, endIdx: newEnd };
      scheduleRender();
      return;
    }

    // Pan: shift the candle window horizontally.
    const dx = e.clientX - drag.startX;
    const visible = viewRef.current.endIdx - viewRef.current.startIdx;
    const candleW = container.clientWidth / visible;
    const shift = Math.round(-dx / candleW);

    let newStart = drag.origStart + shift;
    let newEnd = newStart + visible;

    if (newStart < 0) { newStart = 0; newEnd = visible; }
    if (newEnd > allLen) { newEnd = allLen; newStart = allLen - visible; }

    viewRef.current = { startIdx: newStart, endIdx: newEnd };
    scheduleRender();
  }, [handleDrawingPointerMove, scheduleRender]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (handleDrawingPointerUp(e)) return;
    pointersRef.current.delete(e.pointerId);
    // End pinch when either finger lifts.
    if (pinchRef.current && pointersRef.current.size < 2) {
      pinchRef.current = null;
    }

    // Resolve a pending touch tap.
    const tap = tapRef.current;
    if (tap && tap.pointerId === e.pointerId) {
      cancelLongPress();
      const heldFor = performance.now() - tap.startTime;
      const movedPx = Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY);
      tapRef.current = null;
      if (tap.candidate && heldFor < 300 && movedPx <= 6) {
        // Genuine quick tap.
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const lx = e.clientX - rect.left;
          const ly = e.clientY - rect.top;
          // If something is already parked, a tap dismisses it (toggle off).
          if (parkedRef.current) {
            parkedRef.current = null;
          } else {
            // Only park inside the chart body — not over axes.
            const inBody = lx > 0 && lx < rect.width - PRICE_AXIS_W &&
                           ly > 0 && ly < rect.height - TIME_AXIS_H;
            if (inBody) {
              parkedRef.current = { x: lx, y: ly };
            }
          }
          scheduleRender();
        }
      }
    }

    dragRef.current.active = false;
    setIsDragging(false);
  }, [cancelLongPress, handleDrawingPointerUp, scheduleRender, PRICE_AXIS_W, TIME_AXIS_H]);

  // Dismiss a parked crosshair when settings change (avoids stale tooltips).
  useEffect(() => {
    if (parkedRef.current) {
      parkedRef.current = null;
      scheduleRender();
    }
    // Intentionally only react to settings identity, not parkedRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Dismiss parked crosshair on outside-tap (anywhere not inside the chart
  // container) or on any document scroll. Both are listed as required
  // dismissal triggers in the spec; combined here so we install one pair
  // of listeners only when something is parked.
  useEffect(() => {
    const onOutsidePointer = (ev: PointerEvent) => {
      if (!parkedRef.current) return;
      const c = containerRef.current;
      if (c && ev.target instanceof Node && !c.contains(ev.target)) {
        parkedRef.current = null;
        scheduleRender();
      }
    };
    const onScroll = () => {
      if (parkedRef.current) {
        parkedRef.current = null;
        scheduleRender();
      }
    };
    document.addEventListener("pointerdown", onOutsidePointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onScroll, true);
    };
  }, [scheduleRender]);

  // Level-aware single-click: if the click lands within 10px of a
  // rendered persistent liquidity level, treat it as a request to open
  // the journal popover anchored to that level. Clicks outside a level
  // and outside the chart axes are no-ops so normal chart interactions
  // (hover crosshair etc.) are not disturbed. Pan drags do not fire
  // click events in browsers unless there was no movement between
  // pointerdown and pointerup, so this does not interfere with panning.
  const tryOpenLevelAt = useCallback((clientX: number, clientY: number): boolean => {
    const container = containerRef.current;
    if (!container || !onLevelClick || renderedLevelsRef.current.length === 0) return false;
    const rect = container.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    // Exclude axis zones — those have their own double-click behavior.
    if (localX >= rect.width - PRICE_AXIS_W) return false;
    if (localY >= rect.height - TIME_AXIS_H) return false;
    const HIT_RADIUS = 10;
    let best: { price: number; y: number; isBid: boolean; tier: "elite" | "strong" | "normal" } | null = null;
    let bestDy = Infinity;
    for (const l of renderedLevelsRef.current) {
      const dy = Math.abs(l.y - localY);
      if (dy < bestDy && dy <= HIT_RADIUS) {
        best = l;
        bestDy = dy;
      }
    }
    if (!best) return false;
    onLevelClick({
      id: best.price.toFixed(8),
      price: best.price,
      side: best.isBid ? "bid" : "ask",
      tier: best.tier === "elite" ? 1 : best.tier === "strong" ? 2 : 3,
    });
    return true;
  }, [PRICE_AXIS_W, TIME_AXIS_H, onLevelClick]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // In compact/grid mode we intentionally do nothing so the parent
    // tile can receive the click and navigate to the full chart.
    if (compact) return;
    // Only fire on a single click (detail === 1). For detail > 1 the
    // dblclick handler below handles axis resets; we don't want to
    // also pop a journal here in that case.
    if (e.detail > 1) return;
    tryOpenLevelAt(e.clientX, e.clientY);
  }, [compact, tryOpenLevelAt]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // Double-click on the price axis resets vertical zoom; on the time axis
    // resets the candle window to full range. (TradingView convention.)
    if (localX >= rect.width - PRICE_AXIS_W) {
      verticalZoomRef.current = 1;
      scheduleRender();
      return;
    }
    if (localY >= rect.height - TIME_AXIS_H) {
      const allLen = totalCandlesRef.current;
      if (allLen > 0) {
        viewRef.current = { startIdx: 0, endIdx: allLen };
        scheduleRender();
      }
      return;
    }
    // Body dblclick also opens a level — retained for muscle memory
    // from the prior implementation where dblclick was the primary
    // gesture. The preceding click already fired and may have opened
    // the popover; if it did, this is a no-op (popover replaces).
    tryOpenLevelAt(e.clientX, e.clientY);
  }, [PRICE_AXIS_W, TIME_AXIS_H, scheduleRender, tryOpenLevelAt]);

  if (isLoading && !data) {
    return (
      <div className="flex-1 bg-[#0c0c1d] flex flex-col justify-center items-center gap-4">
        <div className="w-12 h-12 border-2 border-cyan-500/40 border-t-transparent rounded-full animate-spin" />
        <div className="text-cyan-400/40 font-mono text-xs tracking-widest animate-pulse">
          LOADING DEPTH DATA...
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden"
      style={{
        minHeight: 0,
        cursor: drawingState.activeTool !== "cursor" ? "crosshair" : isDragging ? "grabbing" : "grab",
        touchAction: "none",
        backgroundColor: settings.canvas.background,
      }}
      role="application"
      aria-label={`${(symbol || "chart").toUpperCase()} ${interval} liquidity heatmap`}
      aria-roledescription="Interactive financial chart"
      onContextMenu={(e) => {
        e.preventDefault();
        openTo("symbol");
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => { hoverRef.current = null; scheduleRender(); }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        style={{
          display: "block",
          position: "absolute",
          top: 0, left: 0,
          width: "100%", height: "100%",
        }}
      />
      {!compact && settings.indicators.some((i) => i.type === "candle_close_timer" && i.visible !== false) && (
        <CandleCloseTimer
          color={
            settings.indicators.find((i) => i.type === "candle_close_timer")?.color ??
            "rgb(187,120,5)"
          }
        />
      )}
      {!compact && (
        <IndicatorLegend
          indicators={settings.indicators}
          symbol={symbol || ""}
          interval={interval}
          topOffset={settings.statusLine.chartValues || settings.statusLine.barChangeValues || settings.statusLine.volume || settings.statusLine.lastDayChangeValues ? 30 : 8}
          onUpdate={(next) => {
            set("indicators", settings.indicators.map((i) => (i.id === next.id ? next : i)));
          }}
          onRemove={(id) => {
            set("indicators", settings.indicators.filter((i) => i.id !== id));
          }}
          onOpenSettings={(id) => setEditingIndicatorId(id)}
        />
      )}
      {!compact && (
        <div
          className="absolute z-20 flex flex-wrap gap-1 pointer-events-auto"
          style={{ left: 8, bottom: 26 }}
          data-testid="analytics-overlay-chips"
        >
          {([
            { key: "funding", label: "FUND", title: "Funding-rate divergence" },
            { key: "oiDelta", label: "ΔOI", title: "Open interest delta" },
            { key: "takerPressure", label: "TAKER", title: "Taker buy/sell pressure" },
            { key: "cvd", label: "CVD", title: "Cumulative volume delta" },
            { key: "magnetZones", label: "MAGNET", title: "Liquidation magnet zones" },
          ] as const).map((chip) => {
            const active = (settings.analyticsOverlays ?? {} as Record<string, boolean>)[chip.key];
            return (
              <button
                key={chip.key}
                type="button"
                title={chip.title}
                onClick={() => set("analyticsOverlays", {
                  ...(settings.analyticsOverlays ?? { funding: false, oiDelta: false, takerPressure: false, cvd: false, magnetZones: false }),
                  [chip.key]: !active,
                })}
                className={
                  "font-mono text-[10px] tracking-wider px-2 py-0.5 rounded border backdrop-blur-sm transition-colors " +
                  (active
                    ? "bg-emerald-500/25 border-emerald-400/60 text-emerald-200"
                    : "bg-black/55 border-white/10 text-white/55 hover:text-white/85 hover:border-white/30")
                }
                data-testid={`analytics-chip-${chip.key}`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      )}
      {!compact && sl.enabled && (
        <div
          className="absolute z-20 pointer-events-none font-mono text-[10px] tracking-wider"
          style={{ right: 8, top: structuralUnsupported ? 36 : 8 }}
          data-testid="structural-diagnostic-badge"
        >
          <div className="px-2 py-1 rounded border border-emerald-400/40 bg-black/65 text-emerald-200 backdrop-blur-sm">
            {/* structuralDiagnosticBadgeV1 */}
            SL zones: {structuralZones.length}
          </div>
        </div>
      )}
      {!compact && sl.enabled && structuralUnsupported && (
        <div
          className="absolute z-20 pointer-events-none font-mono text-[10px] tracking-wider"
          style={{ right: 8, top: 8 }}
          data-testid="structural-levels-unsupported"
        >
          <div className="px-2 py-1 rounded border border-white/15 bg-black/55 text-white/70 backdrop-blur-sm">
            Structural levels aren&apos;t available for this symbol
          </div>
        </div>
      )}
      <IndicatorSettingsDialog
        indicator={settings.indicators.find((i) => i.id === editingIndicatorId) ?? null}
        onClose={() => setEditingIndicatorId(null)}
        onChange={(next) => {
          set("indicators", settings.indicators.map((i) => (i.id === next.id ? next : i)));
        }}
        onRemove={(id) => {
          set("indicators", settings.indicators.filter((i) => i.id !== id));
        }}
      />
    </div>
  );
}

function CandleCloseTimer({ color }: { color: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const fmt = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
    return `${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  };
  const next30m = Math.ceil(now / (30 * 60 * 1000)) * (30 * 60 * 1000);
  const next4h = Math.ceil(now / (4 * 60 * 60 * 1000)) * (4 * 60 * 60 * 1000);
  return (
    <div
      className="absolute top-2 right-[58px] z-20 pointer-events-none font-mono text-[11px] tracking-wider px-2.5 py-1.5 rounded border bg-black/55 backdrop-blur-sm"
      style={{ color, borderColor: `${color.replace("rgb", "rgba").replace(")", ",0.35)")}` }}
    >
      <div className="flex items-center gap-2">
        <span className="opacity-60">30m</span>
        <span className="font-semibold tabular-nums">{fmt(next30m - now)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="opacity-60">4h&nbsp;</span>
        <span className="font-semibold tabular-nums">{fmt(next4h - now)}</span>
      </div>
    </div>
  );
}
