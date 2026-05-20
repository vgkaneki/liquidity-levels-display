// Unified candle source with transparent Toobit fallback.
//
// The structural-levels engine consumes Hyperliquid candles. When HL is
// unreachable for a given symbol (rate-limit, 5xx, network blip) or has
// no listing for it, this module transparently re-fetches the same
// horizon from Toobit and reshapes the bars into the HlCandle wire shape
// the engine already understands. There is no global "we're in fallback
// mode" flag — each call independently decides per `(coin, interval,
// lookbackMs)` and the next call re-tries the primary as soon as its
// cache entry expires, so HL recovery is automatic.
//
// Out of scope: blending (we always return one source's bars, never a
// mix), changing the engine math, or replacing the realtime liquidations
// path. See .local/tasks/toobit-candle-fallback.md for the full contract.

import * as hl from "./hyperliquid";
import type { HlCandle } from "./hyperliquid";
import { fetchKlines, type ToobitKline } from "../routes/liquidity/exchanges/toobit";
import { toobitEnabled } from "../middlewares/toobitGate";
import { logger } from "../lib/logger";
import * as symbolRegistry from "./symbolRegistry";
import { logDisagreement } from "./symbolRegistry/disagreementLog";

export type CandleSource = "hyperliquid" | "toobit";

export interface SourcedCandles {
  candles: HlCandle[];
  source: CandleSource;
}

// Cross-venue base-name mapping. Most assets share a base symbol across
// exchanges; only the handful below differ. Default behavior is a pure
// passthrough — if a base is missing here we use it verbatim on Toobit.
//   - POL on HL ↔ MATIC on Toobit (Polygon's 2024 ticker rename was not
//     applied uniformly across venues).
const HL_BASE_TO_TOOBIT_BASE: Record<string, string> = {
  POL: "MATIC",
};

// Strip USDT/USD/“-” decoration and uppercase to get a bare HL coin
// (matches the convention used by services/hyperliquid.ts callers).
function toBareCoin(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/USDT?$/, "");
}

function toobitNativeFor(input: string): string {
  const hlBase = toBareCoin(input);
  if (!hlBase) return "";
  const ui = `${hlBase}USDT`;
  const fromRegistry = symbolRegistry.toNative(ui, "toobit");
  const tbBase = HL_BASE_TO_TOOBIT_BASE[hlBase] ?? hlBase;
  const legacy = `${tbBase}-SWAP-USDT`;
  if (fromRegistry && fromRegistry !== legacy) {
    logDisagreement("candleSource.toobitNativeFor", ui, fromRegistry, legacy);
  }
  return fromRegistry ?? legacy;
}

// Toobit's REST kline endpoint accepts a slightly different interval
// alphabet than HL — and crucially, Toobit's monthly bucket is the
// case-sensitive string "1M". A blanket .toLowerCase() here would map
// "1M" (month) to "1m" (minute) and silently return per-minute bars for
// a monthly request, so we use an explicit table that preserves case
// for month and lowercases everything else.
const TOOBIT_INTERVAL_TABLE: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
  "8h": "12h", // Toobit has no 8h bucket — closest supported equivalent.
  "1d": "1d", "3d": "3d", "1w": "1w",
  "1M": "1M", "1mo": "1M", "1month": "1M", // monthly: case-sensitive on Toobit
};

function toobitIntervalFor(interval: string): string {
  // Try exact match first so case-sensitive monthly tokens survive.
  const direct = TOOBIT_INTERVAL_TABLE[interval];
  if (direct) return direct;
  const lower = TOOBIT_INTERVAL_TABLE[interval.toLowerCase()];
  return lower ?? "1h";
}

// Approximate ms-per-bar for the intervals the engine can request. Used
// only to size the Toobit `limit` so we ask for roughly the same number
// of bars HL would have returned for `lookbackMs`. Capped at Toobit's
// 1000-bar API ceiling.
const INTERVAL_MS_FOR_BARS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000,
  "1w": 604_800_000, "1M": 2_592_000_000,
};

function toobitBarLimit(toobitInterval: string, lookbackMs: number): number {
  // Use the *mapped* Toobit interval so 8h→12h doesn't ask for 1.5x the
  // intended bar count. Falls back to 1h ms if the mapped interval is
  // somehow unknown.
  const ms = INTERVAL_MS_FOR_BARS[toobitInterval] ?? 3_600_000;
  const bars = Math.ceil(lookbackMs / ms);
  return Math.max(1, Math.min(1000, bars));
}

// Same TTL ladder as services/hyperliquid.ts so cached Toobit results
// expire at the same cadence HL would have refreshed at, ensuring HL
// recovery is picked up on the very next miss after its TTL window.
function ttlMsFor(interval: string): number {
  const i = interval.toLowerCase();
  if (i === "1d" || i === "3d" || i === "1w" || i === "1mo" || i === "1month") return 15 * 60_000;
  if (i === "4h" || i === "8h" || i === "12h") return 5 * 60_000;
  if (i === "1h" || i === "2h") return 60_000;
  return 30_000;
}

interface CacheEntry { value: SourcedCandles; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SourcedCandles>>();

// Token bucket so the fallback can never punish Toobit the way HL was
// being punished before Task #86. 4 req/s with a small burst matches
// Toobit's published limits with comfortable headroom.
const TOOBIT_RATE_PER_SEC = 4;
const TOOBIT_BURST = 6;
let toobitTokens = TOOBIT_BURST;
let toobitLastRefill = Date.now();
const toobitWaiters: Array<() => void> = [];

function refillToobit(): void {
  const now = Date.now();
  const elapsed = (now - toobitLastRefill) / 1000;
  if (elapsed > 0) {
    toobitTokens = Math.min(TOOBIT_BURST, toobitTokens + elapsed * TOOBIT_RATE_PER_SEC);
    toobitLastRefill = now;
  }
  while (toobitTokens >= 1 && toobitWaiters.length > 0) {
    toobitTokens -= 1;
    const w = toobitWaiters.shift();
    if (w) w();
  }
}

function acquireToobitToken(): Promise<void> {
  refillToobit();
  if (toobitTokens >= 1) {
    toobitTokens -= 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    toobitWaiters.push(resolve);
    setTimeout(refillToobit, 1000 / TOOBIT_RATE_PER_SEC + 5);
  });
}

function isTransientHlError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Hyperliquid\s+(?:429|5\d\d)/.test(msg)) return true;
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|aborted/i.test(msg)) return true;
  return false;
}

function toobitToHlCandle(
  coin: string,
  interval: string,
  k: ToobitKline,
  intervalMs: number,
): HlCandle {
  return {
    t: k.timestamp,
    T: k.timestamp + intervalMs - 1,
    s: coin,
    i: interval,
    o: String(k.open),
    c: String(k.close),
    h: String(k.high),
    l: String(k.low),
    v: String(k.volume),
    n: 0,
  };
}

async function fetchFromToobit(
  coin: string,
  interval: string,
  lookbackMs: number,
): Promise<HlCandle[] | null> {
  // Phase 1 SymbolRegistry — if registry definitively reports the
  // symbol is not listed on Toobit, skip the upstream call. "unknown"
  // (cold-boot or stale snapshot) still attempts the fetch so behavior
  // is preserved during the warm window.
  const ui = `${coin.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/USDT?$/, "")}USDT`;
  if (symbolRegistry.isListed(ui, "toobit") === "no") return null;
  const native = toobitNativeFor(coin);
  if (!native) return null;
  const tbInterval = toobitIntervalFor(interval);
  const limit = toobitBarLimit(tbInterval, lookbackMs);
  await acquireToobitToken();
  const klines = await fetchKlines(native, tbInterval, limit);
  if (!klines || klines.length === 0) return null;
  const intervalMs = INTERVAL_MS_FOR_BARS[tbInterval] ?? 3_600_000;
  // Toobit's REST kline parser only validates `timestamp` and `close`,
  // so a malformed bar can still slip through with NaN open/high/low/
  // volume. Stringifying NaN here would poison every downstream
  // numeric transform (returns, ATR, KDE, GARCH, …) — drop those bars.
  const clean = klines.filter(
    (k) =>
      Number.isFinite(k.timestamp) &&
      Number.isFinite(k.open) &&
      Number.isFinite(k.high) &&
      Number.isFinite(k.low) &&
      Number.isFinite(k.close) &&
      Number.isFinite(k.volume),
  );
  if (clean.length === 0) return null;
  // Sort ascending in case Toobit returns newest-first (some endpoint
  // versions do) — the engine assumes chronological order.
  clean.sort((a, b) => a.timestamp - b.timestamp);
  return clean.map((k) => toobitToHlCandle(coin, interval, k, intervalMs));
}

/**
 * Fetch candles for `(coin, interval, lookbackMs)` with transparent
 * Toobit fallback. Always tries Hyperliquid first; only consults Toobit
 * when HL throws a transient error or returns an empty/null bar list,
 * AND the operator has enabled the Toobit gate. Result is cached for
 * the same TTL HL itself would have used, with `source` preserved so
 * callers can surface the active feed.
 */
export async function fetchCandlesSourced(
  coin: string,
  interval: string,
  lookbackMs: number,
): Promise<SourcedCandles> {
  const ttl = ttlMsFor(interval);
  const bucket = Math.floor(Date.now() / ttl);
  const key = `${coin}:${interval}:${lookbackMs}:${bucket}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<SourcedCandles> => {
    let hlCandles: HlCandle[] | null = null;
    let hlError: unknown = null;
    try {
      hlCandles = await hl.fetchCandles(coin, interval, lookbackMs);
    } catch (err) {
      hlError = err;
    }

    const hlEmpty = !hlCandles || hlCandles.length === 0;
    if (!hlEmpty) {
      return { candles: hlCandles!, source: "hyperliquid" };
    }

    if (hlError && !isTransientHlError(hlError)) {
      // Non-transient HL failure (parse error, fatal HTTP). Don't mask
      // it with a Toobit fallback — let the caller surface the bug.
      throw hlError;
    }

    if (!toobitEnabled()) {
      // Toobit is gated off (e.g. operator hasn't opted in for this
      // jurisdiction). Preserve the original behavior: empty array for
      // unsupported symbols, throw for transient HL errors.
      if (hlError) throw hlError;
      return { candles: [], source: "hyperliquid" };
    }

    try {
      const tb = await fetchFromToobit(coin, interval, lookbackMs);
      if (tb && tb.length > 0) {
        logger.info(
          { coin, interval, lookbackMs, hlError: hlError ? String(hlError) : null, bars: tb.length },
          "candleSource: served from Toobit fallback",
        );
        return { candles: tb, source: "toobit" };
      }
    } catch (tbErr) {
      logger.warn(
        { coin, interval, err: String(tbErr) },
        "candleSource: Toobit fallback also failed",
      );
    }

    if (hlError) throw hlError;
    return { candles: [], source: "hyperliquid" };
  })();

  inFlight.set(key, promise);
  try {
    const value = await promise;
    // Toobit fallback entries get a much shorter TTL than HL successes
    // so that HL recovery is re-attempted soon after it comes back —
    // otherwise a single HL hiccup could pin the response on Toobit
    // for the full HL TTL window even after HL is healthy again. HL
    // hits use the full ladder TTL because that's what the engine has
    // always relied on. Source is encoded in the cached value, so a
    // toobit-tagged cached entry stays correctly tagged while it lives.
    const effectiveTtl = value.source === "toobit" ? Math.min(ttl, 15_000) : ttl;
    cache.set(key, { value, expiresAt: Date.now() + effectiveTtl });
    return value;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop-in replacement for `hyperliquid.fetchCandles` — returns just the
 * bar array so existing call sites don't need to change. Use
 * {@link fetchCandlesSourced} when you also need the source tag.
 */
export async function fetchCandles(
  coin: string,
  interval: string,
  lookbackMs: number,
): Promise<HlCandle[]> {
  const sourced = await fetchCandlesSourced(coin, interval, lookbackMs);
  return sourced.candles;
}

// Phase 3 (IDatafeed) — sibling to fetchCandlesSourced for explicit
// time-range requests. Hyperliquid handles arbitrary [startTime,endTime]
// via candleSnapshot natively. Toobit's REST kline endpoint we wrap is
// limit-based with no startTime/endTime knobs, so the Toobit fallback
// derives a lookback from `(now - fromMs)`, fetches that many bars, and
// filters down to the requested window. That preserves the behavior
// users care about — recent-history pans and TV's "load more bars to
// the left" — without refactoring the lookback path. Cache is
// range-keyed so it cannot collide with the lookback cache.
// Bounded so high-cardinality range keys (e.g. TradingView panning that
// shifts the [from,to] window by a few bars on every scroll) cannot grow
// the Map without limit. Map iteration is insertion-order so deleting
// the first key when at cap gives FIFO eviction — adequate for a window
// where the working set is dozens of recently-viewed (sym,interval,
// range) triples, not thousands.
const RANGE_CACHE_MAX_ENTRIES = 1_000;
const rangeCache = new Map<string, CacheEntry>();
const rangeInflight = new Map<string, Promise<SourcedCandles>>();

function evictRangeCacheIfFull(): void {
  while (rangeCache.size >= RANGE_CACHE_MAX_ENTRIES) {
    const oldestKey = rangeCache.keys().next().value;
    if (oldestKey === undefined) break;
    rangeCache.delete(oldestKey);
  }
}

async function fetchFromToobitRange(
  coin: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<HlCandle[] | null> {
  const lookbackMs = Math.max(0, Date.now() - fromMs);
  if (lookbackMs <= 0) return null;
  const bars = await fetchFromToobit(coin, interval, lookbackMs);
  if (!bars || bars.length === 0) return null;
  return bars.filter((b) => b.t >= fromMs && b.t <= toMs);
}

export async function fetchCandlesSourcedRange(
  coin: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<SourcedCandles> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { candles: [], source: "hyperliquid" };
  }
  const ttl = ttlMsFor(interval);
  const bucket = Math.floor(Date.now() / ttl);
  const key = `range:${coin}:${interval}:${fromMs}:${toMs}:${bucket}`;

  const hit = rangeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const existing = rangeInflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<SourcedCandles> => {
    let hlCandles: HlCandle[] | null = null;
    let hlError: unknown = null;
    try {
      hlCandles = await hl.fetchCandlesRange(coin, interval, fromMs, toMs);
    } catch (err) {
      hlError = err;
    }

    const hlEmpty = !hlCandles || hlCandles.length === 0;
    if (!hlEmpty) {
      return { candles: hlCandles!, source: "hyperliquid" };
    }

    if (hlError && !isTransientHlError(hlError)) {
      throw hlError;
    }

    if (!toobitEnabled()) {
      if (hlError) throw hlError;
      return { candles: [], source: "hyperliquid" };
    }

    try {
      const tb = await fetchFromToobitRange(coin, interval, fromMs, toMs);
      if (tb && tb.length > 0) {
        logger.info(
          { coin, interval, fromMs, toMs, hlError: hlError ? String(hlError) : null, bars: tb.length },
          "candleSource: range served from Toobit fallback",
        );
        return { candles: tb, source: "toobit" };
      }
    } catch (tbErr) {
      logger.warn(
        { coin, interval, err: String(tbErr) },
        "candleSource: range Toobit fallback also failed",
      );
    }

    if (hlError) throw hlError;
    return { candles: [], source: "hyperliquid" };
  })();

  rangeInflight.set(key, promise);
  try {
    const value = await promise;
    const effectiveTtl = value.source === "toobit" ? Math.min(ttl, 15_000) : ttl;
    rangeCache.delete(key);
    evictRangeCacheIfFull();
    rangeCache.set(key, { value, expiresAt: Date.now() + effectiveTtl });
    return value;
  } finally {
    rangeInflight.delete(key);
  }
}

// Test-only escape hatch so unit tests can flush the source-decision
// cache between fixtures without leaking state. Covers both the legacy
// lookback cache and the Phase 3 range cache so range-mode tests start
// from a clean slate.
export function __resetCandleSourceCache(): void {
  cache.clear();
  inFlight.clear();
  rangeCache.clear();
  rangeInflight.clear();
}
