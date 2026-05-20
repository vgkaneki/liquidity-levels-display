import type { OhlcvBar } from "./levels";

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isValidBar(bar: OhlcvBar | undefined): bar is OhlcvBar {
  return !!bar && finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close) && finite(bar.volume) && bar.high >= bar.low;
}

function normalizeZone(low: number, high: number): { low: number; high: number } | null {
  if (!finite(low) || !finite(high)) return null;
  if (high < low) [low, high] = [high, low];
  return high >= low ? { low, high } : null;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Reversal-candle filter: classic hammer / shooting-star body-to-wick ratio at the level.
export function isReversalCandle(bar: OhlcvBar, kind: "support" | "resistance" | "neutral"): boolean {
  if (!isValidBar(bar)) return false;
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const body = Math.abs(bar.close - bar.open);
  const wickLow = Math.min(bar.open, bar.close) - bar.low;
  const wickHigh = bar.high - Math.max(bar.open, bar.close);
  if (kind === "support") return wickLow > body * 1.5 && wickLow / range > 0.5;
  if (kind === "resistance") return wickHigh > body * 1.5 && wickHigh / range > 0.5;
  return false;
}

// Volume surge filter: current bar volume exceeds (rolling mean + sigmaK · σ)
// over the last `lookback` bars. Defaults to lookback=50, sigmaK=1.5 — the
// canonical "1.5σ over rolling 50" reliability rule.
export function isVolumeSurge(
  bars: OhlcvBar[],
  idx: number,
  lookback = 50,
  sigmaK = 1.5,
): boolean {
  const safeLookback = finite(lookback) ? Math.max(1, Math.floor(lookback)) : 50;
  const safeIdx = finite(idx) ? Math.floor(idx) : -1;
  const k = finite(sigmaK) ? Math.max(0, sigmaK) : 1.5;
  if (safeIdx < safeLookback || safeIdx >= bars.length || !isValidBar(bars[safeIdx])) return false;
  const recent = bars.slice(safeIdx - safeLookback, safeIdx).filter(isValidBar);
  if (recent.length < safeLookback) return false;
  const mean = recent.reduce((s, b) => s + Math.max(0, b.volume), 0) / recent.length;
  const variance =
    recent.reduce((s, b) => s + (Math.max(0, b.volume) - mean) ** 2, 0) / recent.length;
  const sigma = Math.sqrt(Math.max(variance, 0));
  const cur = Math.max(0, bars[safeIdx]!.volume);
  return cur > mean + k * sigma;
}

// Confirm a zone using ONLY the FIRST candle that tests the zone in the recent
// window. That candle must (a) close in the reversal direction, (b) form a
// reversal candle (hammer/shooting-star body-to-wick ratio), and
// (c) coincide with a 1.5σ-rolling-50 volume surge. If the first test fails
// any of these, the zone is unconfirmed — no later touches can rescue it.
export function confirmZone(
  bars: OhlcvBar[],
  low: number,
  high: number,
  kind: "support" | "resistance" | "neutral",
): boolean {
  const z = normalizeZone(low, high);
  if (!z || kind === "neutral") return false;
  const window = Math.min(bars.length, 60);
  const start = bars.length - window;
  let firstTestIdx = -1;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    if (!isValidBar(b)) continue;
    if (b.low <= z.high && b.high >= z.low) {
      firstTestIdx = i;
      break;
    }
  }
  if (firstTestIdx < 0) return false;
  const b = bars[firstTestIdx]!;
  const mid = (b.low + b.high) / 2;
  const closesInReversalDir =
    kind === "support"
      ? b.close > mid
      : kind === "resistance"
        ? b.close < mid
        : false;
  if (!closesInReversalDir) return false;
  if (!isReversalCandle(b, kind)) return false;
  if (!isVolumeSurge(bars, firstTestIdx)) return false;
  return true;
}

// Detect simple RSI divergence between price swing highs/lows and an RSI(14) series.
export function rsi(closes: number[], period = 14): number[] {
  const clean = closes.filter((x) => finite(x));
  const safePeriod = finite(period) ? Math.max(1, Math.floor(period)) : 14;
  if (clean.length < safePeriod + 1) return [];
  const out: number[] = [];
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= safePeriod; i++) {
    const diff = clean[i]! - clean[i - 1]!;
    if (diff > 0) gains += diff;
    else if (diff < 0) losses -= diff;
  }
  let avgGain = gains / safePeriod;
  let avgLoss = losses / safePeriod;
  out.push(rsiValue(avgGain, avgLoss));
  for (let i = safePeriod + 1; i < clean.length; i++) {
    const diff = clean[i]! - clean[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (safePeriod - 1) + g) / safePeriod;
    avgLoss = (avgLoss * (safePeriod - 1) + l) / safePeriod;
    out.push(rsiValue(avgGain, avgLoss));
  }
  return out;
}

export function findDivergences(bars: OhlcvBar[]): Array<{ time: number; price: number; kind: string; magnitude: number }> {
  const clean = bars.filter(isValidBar);
  const closes = clean.map((b) => b.close);
  const r = rsi(closes);
  if (r.length < 20) return [];
  const offset = closes.length - r.length;
  const out: Array<{ time: number; price: number; kind: string; magnitude: number }> = [];
  const window = 5;
  for (let i = window; i < r.length - window; i++) {
    const barIdx = i + offset;
    const b = clean[barIdx];
    if (!b) continue;
    const priceSlice = closes.slice(barIdx - window, barIdx + window + 1);
    const rsiSlice = r.slice(i - window, i + window + 1);
    const isPriceLow = priceSlice.every((p) => p >= b.close);
    const isPriceHigh = priceSlice.every((p) => p <= b.close);
    const rsiCenter = rsiSlice[window] ?? 50;
    const isRsiHigher = rsiSlice.every((x) => x <= rsiCenter);
    const isRsiLower = rsiSlice.every((x) => x >= rsiCenter);
    if (isPriceLow && isRsiHigher) out.push({ time: b.time, price: b.low, kind: "bullish", magnitude: rsiCenter });
    if (isPriceHigh && isRsiLower) out.push({ time: b.time, price: b.high, kind: "bearish", magnitude: rsiCenter });
  }
  return out.slice(-8);
}
