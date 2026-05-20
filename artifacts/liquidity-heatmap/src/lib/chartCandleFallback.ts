export interface ChartCandleLike {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const lastGoodByKey = new Map<string, ChartCandleLike[]>();

function keyFor(symbol: string, interval: string): string {
  return `${symbol}|${interval}`.toUpperCase();
}

export function rememberLastGoodCandles(symbol: string, interval: string, candles: ChartCandleLike[] | null | undefined): void {
  if (!symbol || !interval || !candles || candles.length === 0) return;
  lastGoodByKey.set(keyFor(symbol, interval), candles.slice(-10_000));
}

export function getLastGoodCandles(symbol: string, interval: string): ChartCandleLike[] | null {
  const exact = lastGoodByKey.get(keyFor(symbol, interval));
  if (exact && exact.length > 0) return exact;
  return null;
}

export function displayCandlesWithFallback(
  symbol: string,
  interval: string,
  candles: ChartCandleLike[] | null,
  candleErrored: boolean,
): ChartCandleLike[] | null {
  if (candles && candles.length > 0) return candles;
  if (!candleErrored) return candles;
  return getLastGoodCandles(symbol, interval);
}

export function isLikelyMobileChartDevice(): boolean {
  if (typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  if (typeof window !== "undefined") {
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return coarse || window.innerWidth <= 768;
  }
  return false;
}

export function candleWatchdogDelayMs(): number {
  const env = Number(import.meta.env.VITE_CANDLE_WATCHDOG_MS ?? "0");
  if (Number.isFinite(env) && env > 0) return Math.max(8_000, env);
  return isLikelyMobileChartDevice() ? 14_000 : 10_000;
}
