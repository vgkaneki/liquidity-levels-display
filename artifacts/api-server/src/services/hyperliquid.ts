import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, setGlobalDispatcher } from "undici";

const HL_API = "https://api.hyperliquid.xyz/info";

// HTTP keep-alive for all upstream calls. Without this, every POST does a
// fresh TCP+TLS handshake to api.hyperliquid.xyz — the #44 timing logs
// showed that handshake cost dominated the per-call wall-clock for cold
// requests. Setting a global undici dispatcher makes the built-in `fetch`
// reuse pooled connections across calls. `connections` is per-origin, so
// 32 is plenty headroom above our MAX_CONCURRENT_FETCHES cap below and
// also covers the OpenAI client and anything else doing fetch in-process.
// keepAliveTimeout sets how long an idle connection stays parked in the
// pool ready for the next request; 30 s is comfortably longer than the
// 30 s levels TTL refresh cadence so back-to-back warm computes for the
// same symbol almost always reuse a live connection.
// hlAgentTimeoutsV1: connectTimeout/bodyTimeout bound per-request wall-clock
// so a stalled TLS handshake or slow response body cannot hold one of the
// MAX_CONCURRENT_FETCHES slots open indefinitely. Values are generous enough
// not to fire on normal HL responses but short enough to free a stuck slot
// well inside the 30 s server request timeout.
const hlAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  connect: {
    timeout: 8_000,  // TLS+TCP handshake cap (ms)
  },
  bodyTimeout: 15_000,  // max time to receive full response body (ms)
  headersTimeout: 10_000, // max time to receive response headers (ms)
});
setGlobalDispatcher(hlAgent);

interface CacheEntry<T> { value: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>();

// In-flight dedupe by cache key (not raw body): concurrent callers for
// the same time-bucketed key share one upstream POST. Cache + TtlCache
// already dedupe higher-level keys; this catches the burst inside one
// /api/levels fan-out where peer-candle fetches collide with foreground.
const inFlight = new Map<string, Promise<unknown>>();

// Strict priority queue under a single hard cap of MAX_CONCURRENT_FETCHES
// simultaneous Hyperliquid POSTs. Foreground waiters (tagged via
// runWithPriority("high", …)) jump ahead of any queued background waiters
// so a foreground click never sits behind a scanner backlog — but the
// total in-flight count is never allowed to exceed the cap.
//
// Cap raised from 4 → 6 in #47: with HTTP keep-alive in place (the
// undici Agent above) the per-call cost dropped enough to allow more
// in-flight calls without opening fresh sockets. We tried 8 first per
// the task plan but the boot wave (8 seed-levels warmers each fanning
// out ~5 HL calls) blew through HL's per-IP burst budget and surfaced
// 429s on the first foreground requests. Stepping down to 6 keeps the
// recursive HTF + peer fan-out parallel without that boot-time spike.
// Combined with the staggered seed-warm schedule in index.ts this
// runs clean on cold start.
const MAX_CONCURRENT_FETCHES = 6;

export type FetchPriority = "high" | "normal";

const priorityStorage = new AsyncLocalStorage<FetchPriority>();

export function runWithPriority<T>(priority: FetchPriority, fn: () => Promise<T>): Promise<T> {
  return priorityStorage.run(priority, fn);
}

function currentPriority(): FetchPriority {
  return priorityStorage.getStore() ?? "normal";
}

let activeFetches = 0;
interface Waiter { resolve: () => void; priority: FetchPriority }
const fetchWaiters: Waiter[] = [];

function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches++;
    return Promise.resolve();
  }
  const priority = currentPriority();
  return new Promise<void>((resolve) => {
    const waiter: Waiter = { resolve, priority };
    if (priority === "high") {
      // Insert before the first normal-priority waiter so foreground
      // requests always wake before any queued scanner work. High
      // waiters preserve FIFO order among themselves.
      const idx = fetchWaiters.findIndex((w) => w.priority === "normal");
      if (idx === -1) fetchWaiters.push(waiter);
      else fetchWaiters.splice(idx, 0, waiter);
    } else {
      fetchWaiters.push(waiter);
    }
  });
}

function releaseFetchSlot(): void {
  activeFetches--;
  // Reserve the slot for the waker (pre-increment) so a synchronous
  // acquireFetchSlot call before the woken waiter resumes can't race
  // us past the cap.
  const next = fetchWaiters.shift();
  if (next) {
    activeFetches++;
    next.resolve();
  }
}

// Global token-bucket rate limiter in front of HL POSTs. The concurrency
// cap above protects us against blowing up our own socket pool, but it
// does NOT bound the *rate* at which requests reach Hyperliquid. The
// boot fan-out (8 warm pairs × ~5 candle/HTF/peer fetches each) plus the
// level-touch warmer ticking every 3s plus the hl-liq-ws reconnect storm
// were collectively triggering HL 429s on our IP, which then surfaced as
// /api/levels HTTP 502s for half the supported symbols. The bucket keeps
// the long-run rate under HL's per-IP soft limit while still allowing
// short bursts for foreground requests.
const RATE_LIMIT_PER_SEC = (() => {
  const n = Number(process.env["HL_RATE_LIMIT_PER_SEC"]);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();
const RATE_LIMIT_BURST = (() => {
  const n = Number(process.env["HL_RATE_LIMIT_BURST"]);
  return Number.isFinite(n) && n > 0 ? n : 6;
})();
// Adaptive backoff: when HL returns a 429, halve the effective per-sec rate
// for a cooldown window (default 60 s). The bucket also caps tokens at half
// the burst during cooldown so a fresh wave can't blow through the budget
// the moment we ease off. We log a single warning per cooldown to avoid log
// spam during sustained pressure. Cooldown extends if more 429s arrive.
const COOLDOWN_MS = 60_000;
let cooldownUntil = 0;
let lastCooldownLogAt = 0;
let last429At = 0;
function inCooldown(): boolean {
  return Date.now() < cooldownUntil;
}
function effectiveRatePerSec(): number {
  return inCooldown() ? RATE_LIMIT_PER_SEC / 2 : RATE_LIMIT_PER_SEC;
}
function effectiveBurst(): number {
  return inCooldown() ? Math.max(1, Math.floor(RATE_LIMIT_BURST / 2)) : RATE_LIMIT_BURST;
}
function noteRateLimit(): void {
  const now = Date.now();
  last429At = now;
  cooldownUntil = now + COOLDOWN_MS;
  pruneWindow(rate429Timestamps, now);
  rate429Timestamps.push(now);
  if (now - lastCooldownLogAt > COOLDOWN_MS) {
    lastCooldownLogAt = now;
    // eslint-disable-next-line no-console
    console.warn(
      `[hl] 429 observed; halving HL rate to ${effectiveRatePerSec()}/s for ${COOLDOWN_MS / 1000}s`,
    );
  }
}
// Rolling-window counters surfaced on /api/upstream-pressure so operators
// (and the toolbar dot) can see *how close* we are to upstream limits, not
// just whether we already crossed them. All three windows are 5 minutes:
// long enough to smooth over a single boot wave, short enough to react to
// a fresh pressure event within one or two refreshes of the UI poll.
const PRESSURE_WINDOW_MS = 5 * 60_000;
const rate429Timestamps: number[] = [];
interface WaitSample { at: number; ms: number }
const waitSamples: WaitSample[] = [];
// Cap the wait-sample buffer so a sustained rate-limit event can't grow
// it without bound between prunes. 2k samples over a 5 min window is one
// sample every ~150 ms which is well above the typical wait cadence.
const MAX_WAIT_SAMPLES = 2_000;

function pruneWindow(buf: number[], now: number): void {
  const cutoff = now - PRESSURE_WINDOW_MS;
  while (buf.length > 0 && buf[0] < cutoff) buf.shift();
}
function pruneSamples(now: number): void {
  const cutoff = now - PRESSURE_WINDOW_MS;
  while (waitSamples.length > 0 && waitSamples[0].at < cutoff) waitSamples.shift();
}
function recordWaitSample(ms: number): void {
  const now = Date.now();
  pruneSamples(now);
  waitSamples.push({ at: now, ms });
  if (waitSamples.length > MAX_WAIT_SAMPLES) {
    waitSamples.splice(0, waitSamples.length - MAX_WAIT_SAMPLES);
  }
}

export function getHlPressure(): {
  rateLimited: boolean;
  cooldownMsRemaining: number;
  last429AgeMs: number | null;
  effectiveRatePerSec: number;
  baseRatePerSec: number;
  tokensWaiting: number;
  avgWaitMs5m: number;
  maxWaitMs5m: number;
  waitSampleCount5m: number;
  count429_5m: number;
} {
  const now = Date.now();
  pruneWindow(rate429Timestamps, now);
  pruneSamples(now);
  let total = 0;
  let max = 0;
  for (const s of waitSamples) {
    total += s.ms;
    if (s.ms > max) max = s.ms;
  }
  const avg = waitSamples.length > 0 ? total / waitSamples.length : 0;
  return {
    rateLimited: inCooldown(),
    cooldownMsRemaining: Math.max(0, cooldownUntil - now),
    last429AgeMs: last429At ? now - last429At : null,
    effectiveRatePerSec: effectiveRatePerSec(),
    baseRatePerSec: RATE_LIMIT_PER_SEC,
    tokensWaiting: bucketWaiters.length,
    avgWaitMs5m: Math.round(avg),
    maxWaitMs5m: Math.round(max),
    waitSampleCount5m: waitSamples.length,
    count429_5m: rate429Timestamps.length,
  };
}
let bucketTokens = RATE_LIMIT_BURST;
let bucketLastRefill = Date.now();
const bucketWaiters: Array<() => void> = [];
function refillBucket(): void {
  const now = Date.now();
  const elapsed = now - bucketLastRefill;
  if (elapsed <= 0) return;
  bucketTokens = Math.min(effectiveBurst(), bucketTokens + (elapsed / 1000) * effectiveRatePerSec());
  bucketLastRefill = now;
}
function acquireToken(): Promise<void> {
  refillBucket();
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    recordWaitSample(0);
    return Promise.resolve();
  }
  const waitStart = Date.now();
  return new Promise<void>((resolve) => {
    bucketWaiters.push(() => {
      recordWaitSample(Date.now() - waitStart);
      resolve();
    });
  });
}
setInterval(() => {
  refillBucket();
  while (bucketTokens >= 1 && bucketWaiters.length > 0) {
    bucketTokens -= 1;
    const w = bucketWaiters.shift();
    if (w) w();
  }
}, 100).unref();

// Bounded retry on 429/5xx with jittered exponential backoff.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffDelayMs(attempt: number): number {
  const base = RETRY_BASE_MS * 2 ** attempt;
  // Add up to ±25% jitter so concurrent retries don't re-collide.
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(50, Math.floor(base + jitter));
}

type Attempt<T> =
  | { kind: "ok"; value: T }
  | { kind: "fatal"; err: unknown }       // do not retry (parse error, non-retryable HTTP)
  | { kind: "retryable"; err: unknown };  // network or 429/5xx

async function attemptOnce<T>(body: unknown): Promise<Attempt<T>> {
  await acquireFetchSlot();
  try {
    await acquireToken();
    let res: Response;
    try {
      res = await fetch(HL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { kind: "retryable", err };
    }
    if (!res.ok) {
      if (res.status === 429) noteRateLimit();
      const text = await res.text().catch(() => "");
      const err = new Error(`Hyperliquid ${res.status}: ${text || "null"}`);
      return isRetryableStatus(res.status) ? { kind: "retryable", err } : { kind: "fatal", err };
    }
    try {
      const value = (await res.json()) as T;
      return { kind: "ok", value };
    } catch (err) {
      // Parse failure on a 2xx is deterministic — surface immediately.
      return { kind: "fatal", err };
    }
  } finally {
    releaseFetchSlot();
  }
}

// hlCircuitBreakerV1: stops hammering Hyperliquid when it is genuinely down,
// rather than letting retries pile up in the priority queue and burning rate-
// limit budget. Transport/scheduling only; engine formulas untouched.
//
// Thresholds: open after 5 consecutive non-retryable failures within a 30 s
// window; probe every 60 s (HALF_OPEN → one trial request); close again after
// 2 successes. These are intentionally conservative — the circuit is a last-
// resort backstop, not a hair-trigger that fires on a single transient error.
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

const CB = {
  state: "CLOSED" as CircuitState,
  failures: 0,
  lastFailureAt: 0,
  halfOpenSuccesses: 0,
  FAILURE_THRESHOLD: 5,
  SUCCESS_THRESHOLD: 2,
  OPEN_DURATION_MS: 60_000,
};

function cbRecordSuccess(): void {
  if (CB.state === "HALF_OPEN") {
    CB.halfOpenSuccesses += 1;
    if (CB.halfOpenSuccesses >= CB.SUCCESS_THRESHOLD) {
      CB.state = "CLOSED";
      CB.failures = 0;
      CB.halfOpenSuccesses = 0;
    }
  } else {
    CB.failures = 0;
  }
}

function cbRecordFailure(): void {
  CB.failures += 1;
  CB.lastFailureAt = Date.now();
  CB.halfOpenSuccesses = 0;
  if (CB.failures >= CB.FAILURE_THRESHOLD) CB.state = "OPEN";
}

function cbCheck(): void {
  if (CB.state === "OPEN" && Date.now() - CB.lastFailureAt >= CB.OPEN_DURATION_MS) {
    CB.state = "HALF_OPEN";
    CB.halfOpenSuccesses = 0;
  }
  if (CB.state === "OPEN") {
    throw new Error("Hyperliquid circuit breaker OPEN — upstream unavailable, skipping request");
  }
}

async function postWithRetry<T>(body: unknown): Promise<T> {
  cbCheck();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const outcome = await attemptOnce<T>(body);
    if (outcome.kind === "ok") { cbRecordSuccess(); return outcome.value; }
    if (outcome.kind === "fatal") { cbRecordFailure(); throw outcome.err; }
    if (attempt >= MAX_RETRIES) { cbRecordFailure(); throw outcome.err; }
    lastErr = outcome.err;
    await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
  }
  cbRecordFailure();
  throw lastErr ?? new Error("Hyperliquid request failed");
}

async function cachedPost<T>(key: string, ttlMs: number, body: unknown): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  // Coalesce concurrent callers asking for the same key.
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    const data = await postWithRetry<T>(body);
    cache.set(key, { value: data, expiresAt: Date.now() + ttlMs });
    return data;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

export interface HlCandle {
  t: number; T: number; s: string; i: string;
  o: string; c: string; h: string; l: string; v: string; n: number;
}

export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: string[];
  dayBaseVlm: string;
}

export interface HlMeta {
  universe: Array<{ name: string; szDecimals: number; maxLeverage: number }>;
}

export interface HlL2Book {
  coin: string;
  time: number;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
}

export interface HlTrade {
  coin: string;
  side: "A" | "B";
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
}

export async function fetchMetaAndCtxs(): Promise<[HlMeta, HlAssetCtx[]]> {
  return cachedPost<[HlMeta, HlAssetCtx[]]>("metaAndCtxs", 5_000, { type: "metaAndAssetCtxs" });
}

// Higher timeframes change slowly: a 4h candle's high/low isn't going to
// move once the bar has closed, and even the live bar moves much less per
// second than a 1m bar. Bumping the cache TTL for higher TFs cuts our HL
// request volume substantially without hurting freshness for users who
// are looking at multi-hour structure. Lower TFs keep the original 30 s
// cadence.
function candleCacheTtlMs(interval: string): number {
  const i = interval.toLowerCase();
  if (i === "1d" || i === "3d" || i === "1w" || i === "1mo" || i === "1month") return 15 * 60_000;
  if (i === "4h" || i === "8h" || i === "12h") return 5 * 60_000;
  if (i === "1h" || i === "2h") return 60_000;
  return 30_000;
}

export async function fetchCandles(coin: string, interval: string, lookbackMs: number): Promise<HlCandle[]> {
  const endTime = Date.now();
  const startTime = endTime - lookbackMs;
  const ttlMs = candleCacheTtlMs(interval);
  // Cache key includes lookbackMs so requests with different horizons
  // (e.g. 200/400/500 bars) cannot collide within the same TTL bucket.
  // The bucket size matches the TTL so cache keys roll over at the same
  // cadence as cache expiry.
  const key = `candles:${coin}:${interval}:${lookbackMs}:${Math.floor(endTime / ttlMs)}`;
  return cachedPost<HlCandle[]>(key, ttlMs, {
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });
}

// Phase 3 (IDatafeed) — sibling to fetchCandles for explicit time-range
// requests. The chart / TradingView adapter asks for "bars from X to Y"
// (e.g. when the user pans into history); the lookback-based fetcher
// above always anchors to `Date.now()` and so cannot serve those.
// Returns the same HlCandle wire shape so downstream consumers (route,
// engine) treat it identically. Cache key is range-scoped to keep it
// disjoint from the lookback path's cache so the two cannot collide.
export async function fetchCandlesRange(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<HlCandle[]> {
  const ttlMs = candleCacheTtlMs(interval);
  const key = `candles-range:${coin}:${interval}:${startTime}:${endTime}:${Math.floor(Date.now() / ttlMs)}`;
  return cachedPost<HlCandle[]>(key, ttlMs, {
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });
}

export async function fetchL2Book(coin: string): Promise<HlL2Book> {
  return cachedPost<HlL2Book>(`l2:${coin}:${Math.floor(Date.now() / 5_000)}`, 5_000, {
    type: "l2Book",
    coin,
  });
}

export async function fetchTrades(coin: string): Promise<HlTrade[]> {
  return cachedPost<HlTrade[]>(`trades:${coin}:${Math.floor(Date.now() / 10_000)}`, 10_000, {
    type: "recentTrades",
    coin,
  });
}

export function intervalToLookbackMs(interval: string, bars: number): number {
  const map: Record<string, number> = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
  };
  const ms = map[interval] ?? 3_600_000;
  return ms * bars;
}

export function candlesToOhlcv(candles: HlCandle[]) {
  return candles.map((c) => ({
    time: Math.floor(c.t / 1000),
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
    volume: Number(c.v),
  }));
}

// Columnar (six parallel arrays) form of the OHLCV rows. Roughly half the
// JSON payload size of the row-shape array because property names aren't
// repeated per bar — preferred wire format for /api/ohlcv. The row-shape
// `candlesToOhlcv` above is still used by the levels engine and other
// in-process consumers that read by-bar.
export interface OhlcvSeries {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export function candlesToOhlcvSeries(candles: HlCandle[]): OhlcvSeries {
  const n = candles.length;
  const time = new Array<number>(n);
  const open = new Array<number>(n);
  const high = new Array<number>(n);
  const low = new Array<number>(n);
  const close = new Array<number>(n);
  const volume = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    time[i] = Math.floor(c.t / 1000);
    open[i] = Number(c.o);
    high[i] = Number(c.h);
    low[i] = Number(c.l);
    close[i] = Number(c.c);
    volume[i] = Number(c.v);
  }
  return { time, open, high, low, close, volume };
}
