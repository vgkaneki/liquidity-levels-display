// Package 3 — shared chart/datafeed normalization helpers.
//
// This file centralizes the chart-facing symbol/interval normalization rules
// so the datafeed, websocket client, and chart-facing hooks stop carrying
// their own subtly-different copies. ENGINE GUARDRAIL: transport helpers only.

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol || '').replace(/-/g, '').toUpperCase();
}

export function sameSymbolKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeSymbolKey(a ?? '') === normalizeSymbolKey(b ?? '');
}

export function normalizeIntervalKey(interval: string): string {
  const raw = String(interval || '').trim();
  if (!raw) return '';
  const m = raw.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (!m) return raw.toLowerCase();
  const num = m[1];
  const unit = m[2].toLowerCase();
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') {
    return `${num}m`;
  }
  if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours') {
    return `${num}H`;
  }
  if (unit === 'd' || unit === 'day' || unit === 'days') {
    return `${num}D`;
  }
  if (unit === 'w' || unit === 'wk' || unit === 'wks' || unit === 'week' || unit === 'weeks') {
    return `${num}W`;
  }
  if (unit === 'mo' || unit === 'mon' || unit === 'month' || unit === 'months' || unit === 'mth' || unit === 'mths') {
    return `${num}M`;
  }
  return `${num}${m[2]}`;
}

export function sameIntervalKey(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeIntervalKey(a ?? '') === normalizeIntervalKey(b ?? '');
}

// Phase 4 additions — universe/watchlist display helpers.
//
// `canonicalizeUiSymbol` is the same canonical form as `normalizeSymbolKey`
// (kept as a separate export so universe/watchlist call sites can use the
// name that matches their domain). `toDisplayUsdtSymbol` projects a
// canonical "BTCUSDT" onto the chart-display form "BTC-USDT".
export function canonicalizeUiSymbol(symbol: string): string {
  return normalizeSymbolKey(symbol);
}

export function toDisplayUsdtSymbol(symbol: string): string {
  const canonical = canonicalizeUiSymbol(symbol);
  return canonical.endsWith("USDT") ? `${canonical.slice(0, -4)}-USDT` : canonical;
}

export function normalizeResolutionLike(value: string): string {
  const v = value.trim();
  if (!v) return v;
  const upper = v.toUpperCase();
  return /^\d+[MHDW]$/.test(upper) ? upper : v.toLowerCase();
}
