// Precision entry methods: locate the EXACT price within a confluence zone where edge is highest.
// Methods: absorption, delta exhaustion, large resting orders (LRO), VWOE.

import type { OhlcvBar } from "./levels";
import type { HlL2Book, HlTrade } from "../hyperliquid";

export interface PrecisionEntry {
  price: number;
  method: string;
  confidence: number;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function zone(low: number, high: number): { low: number; high: number; mid: number } | null {
  if (!finite(low) || !finite(high)) return null;
  if (high < low) [low, high] = [high, low];
  if (high <= low) return null;
  return { low, high, mid: (low + high) / 2 };
}

function tradeSize(t: HlTrade): number | null {
  const sz = Number(t.sz);
  return finite(sz) && sz > 0 ? sz : null;
}

function clampPrice(px: number, low: number, high: number): number {
  return Math.min(Math.max(px, low), high);
}

// Large Resting Orders — within the zone, find the price level with the largest book size.
export function largestRestingOrder(book: HlL2Book, low: number, high: number): PrecisionEntry | null {
  const z = zone(low, high);
  if (!z) return null;
  const levels = (book as { levels?: unknown }).levels;
  const bids = Array.isArray(levels) && Array.isArray(levels[0]) ? levels[0] as Array<{ px?: unknown; sz?: unknown }> : [];
  const asks = Array.isArray(levels) && Array.isArray(levels[1]) ? levels[1] as Array<{ px?: unknown; sz?: unknown }> : [];
  const all = [...bids, ...asks];
  let best: { px: number; sz: number } | null = null;
  for (const lvl of all) {
    const px = Number(lvl.px);
    const sz = Number(lvl.sz);
    if (!finite(px) || !finite(sz) || sz <= 0) continue;
    if (px >= z.low && px <= z.high) {
      if (!best || sz > best.sz) best = { px, sz };
    }
  }
  if (!best) return null;
  return { price: best.px, method: "large-resting-order", confidence: Math.min(1, best.sz / 1000) };
}

// Absorption — within the zone, find the price where buy/sell aggressor volume is most lopsided
// against price progression (i.e. heavy aggressor flow without breakout).
export function absorptionEntry(trades: HlTrade[], low: number, high: number): PrecisionEntry | null {
  const z = zone(low, high);
  if (!z) return null;
  const buckets = new Map<number, { buy: number; sell: number }>();
  const bucketCount = 50;
  const tickSize = (z.high - z.low) / bucketCount;
  if (!finite(tickSize) || tickSize <= 0) return null;
  for (const t of trades) {
    const px = Number(t.px);
    const sz = tradeSize(t);
    if (!finite(px) || sz === null || px < z.low || px > z.high) continue;
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor((px - z.low) / tickSize)));
    let agg = buckets.get(bucket);
    if (!agg) { agg = { buy: 0, sell: 0 }; buckets.set(bucket, agg); }
    if (t.side === "B") agg.buy += sz; else agg.sell += sz;
  }
  let bestBucket = -1;
  let bestScore = 0;
  for (const [b, agg] of buckets) {
    const total = agg.buy + agg.sell;
    if (total === 0) continue;
    const imbalance = Math.abs(agg.buy - agg.sell) / total;
    const score = imbalance * total;
    if (score > bestScore) { bestScore = score; bestBucket = b; }
  }
  if (bestBucket < 0) return null;
  return {
    price: clampPrice(z.low + (bestBucket + 0.5) * tickSize, z.low, z.high),
    method: "absorption",
    confidence: Math.min(1, bestScore / 100),
  };
}

function isValidBar(b: OhlcvBar | undefined): b is OhlcvBar {
  return !!b && finite(b.open) && finite(b.high) && finite(b.low) && finite(b.close) && finite(b.volume) && b.high >= b.low;
}

// Delta exhaustion — find the bar within recent history that touched the zone with the largest CVD reversal.
export function deltaExhaustion(bars: OhlcvBar[], low: number, high: number): PrecisionEntry | null {
  const z = zone(low, high);
  if (!z) return null;
  let best: { price: number; mag: number } | null = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (!isValidBar(b)) continue;
    if (b.low > z.high || b.high < z.low) continue;
    const range = b.high - b.low;
    const wickLow = Math.max(0, Math.min(b.open, b.close) - b.low);
    const wickHigh = Math.max(0, b.high - Math.max(b.open, b.close));
    const wick = Math.max(wickLow, wickHigh);
    const mag = (wick / Math.max(range, 1e-9)) * Math.max(0, b.volume);
    const px = wickLow > wickHigh ? b.low : b.high;
    if (finite(mag) && px >= z.low && px <= z.high && (!best || mag > best.mag)) best = { price: px, mag };
  }
  if (!best) return null;
  return { price: best.price, method: "delta-exhaustion", confidence: Math.min(1, best.mag / 1000) };
}

// Volume-Weighted Order-Flow Equilibrium (VWOE) — VWAP of recent trades within the zone.
export function vwoe(trades: HlTrade[], low: number, high: number): PrecisionEntry | null {
  const z = zone(low, high);
  if (!z) return null;
  let pxVol = 0;
  let vol = 0;
  for (const t of trades) {
    const px = Number(t.px);
    const sz = tradeSize(t);
    if (!finite(px) || sz === null || px < z.low || px > z.high) continue;
    pxVol += px * sz;
    vol += sz;
  }
  if (vol === 0) return null;
  return { price: pxVol / vol, method: "vwoe", confidence: Math.min(1, vol / 100) };
}

// Tape-VWAP fallback: VWAP of the most recent N trades INSIDE the zone.
// Falls back to *all* recent trades clamped to the zone if none traded inside,
// and only as a last resort returns the zone midpoint. This guarantees the
// precise entry tracks real flow rather than an arbitrary midpoint.
function tapeFallback(trades: HlTrade[], low: number, high: number, mid: number, n = 200): { price: number; method: string } {
  const z = zone(low, high);
  if (!z) return { price: finite(mid) ? mid : 0, method: "midpoint" };
  const fallbackMid = finite(mid) ? clampPrice(mid, z.low, z.high) : z.mid;
  const take = finite(n) ? Math.max(1, Math.floor(n)) : 200;
  const recent = trades.slice(-take);
  const inside = recent.filter((t) => {
    const px = Number(t.px);
    const sz = tradeSize(t);
    return finite(px) && sz !== null && px >= z.low && px <= z.high;
  });
  if (inside.length > 0) {
    let pxVol = 0;
    let vol = 0;
    for (const t of inside) {
      const px = Number(t.px);
      const sz = tradeSize(t);
      if (sz === null || !finite(px)) continue;
      pxVol += px * sz;
      vol += sz;
    }
    if (vol > 0) return { price: pxVol / vol, method: "tape-vwap-inside" };
  }
  if (recent.length > 0) {
    let pxVol = 0;
    let vol = 0;
    for (const t of recent) {
      const px = Number(t.px);
      const sz = tradeSize(t);
      if (sz === null || !finite(px)) continue;
      pxVol += clampPrice(px, z.low, z.high) * sz;
      vol += sz;
    }
    if (vol > 0) return { price: pxVol / vol, method: "tape-vwap-clamped" };
  }
  return { price: fallbackMid, method: "midpoint" };
}

export function pickPrecisionEntry(
  bars: OhlcvBar[],
  trades: HlTrade[],
  book: HlL2Book,
  low: number,
  high: number,
  fallback: number,
): { price: number; method: string } {
  const z = zone(low, high);
  if (!z) return { price: finite(fallback) ? fallback : 0, method: "midpoint" };
  const candidates = [
    largestRestingOrder(book, z.low, z.high),
    absorptionEntry(trades, z.low, z.high),
    deltaExhaustion(bars, z.low, z.high),
    vwoe(trades, z.low, z.high),
  ].filter(Boolean) as PrecisionEntry[];
  if (candidates.length === 0) return tapeFallback(trades, z.low, z.high, fallback);
  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0]!;
  return { price: clampPrice(top.price, z.low, z.high), method: top.method };
}
