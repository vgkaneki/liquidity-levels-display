// Hyperliquid historical candle fetcher for the validation harness.
// VALIDATION-ONLY. Read-only access to the sealed HL client.
//
// HARD GUARANTEES:
//   - Hyperliquid is the only data source. No OKX / Toobit / KCEX / synthetic.
//   - The validation-only on-disk series cache (seriesCache.ts) lives under
//     reports/hl-validation/cache/ and is fully isolated from the live HL
//     TtlCache used by the production engine.
//   - Cached payloads were originally fetched from Hyperliquid; using
//     them on a re-run is functionally equivalent to fetching them again
//     (modulo HL throttling).
//   - Live caches are not mutated by these reads.
//
// Hyperliquid's candleSnapshot endpoint caps each response at ~5000 bars.
// For deep ranges we page server-side by requesting consecutive windows
// and de-dupe by `t`. We never call any other exchange.

import { fetchCandlesRange, type HlCandle, candlesToOhlcv, intervalToLookbackMs } from "../hyperliquid";
import type { OhlcvBar } from "../engines/levels";
import { logger } from "../../lib/logger";
import { readCachedSeries, writeCachedSeries } from "./seriesCache";

export interface FetchedSeries {
  coin: string;
  interval: string;
  bars: OhlcvBar[];      // sorted ascending by time (seconds)
  rawCount: number;
  windowStartMs: number;
  windowEndMs: number;
  source: "hyperliquid";
  cacheHit: boolean;     // true → loaded from validation-only on-disk cache
}

export interface FetchOptions {
  signal?: AbortSignal;
  // Hard wall-clock deadline (ms epoch) for THIS series fetch. If the
  // current time exceeds the deadline the fetcher aborts gracefully and
  // returns whatever bars it has so far (the caller turns that into a
  // SeriesFetchOutcome with status=skipped-deadline).
  deadlineMs?: number;
  // If false, ignore the on-disk cache (force a fresh HL fetch).
  useCache?: boolean;
  // Reports the number of bars fetched so far for the watchdog status.
  onProgress?: (barsSoFar: number) => void;
}

const MAX_BARS_PER_REQUEST = 4900;

class FetchDeadlineError extends Error {
  constructor(public readonly barsSoFar: number) {
    super(`fetch deadline exceeded after ${barsSoFar} bars`);
    this.name = "FetchDeadlineError";
  }
}

export function isFetchDeadlineError(e: unknown): e is { barsSoFar: number; name: string } {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "FetchDeadlineError";
}

export async function fetchHistoricalSeries(
  coin: string,
  interval: string,
  lookbackDays: number,
  signalOrOpts?: AbortSignal | FetchOptions,
): Promise<FetchedSeries> {
  const opts: FetchOptions = signalOrOpts && "deadlineMs" in (signalOrOpts as object)
    ? (signalOrOpts as FetchOptions)
    : { signal: signalOrOpts as AbortSignal | undefined };
  const useCache = opts.useCache ?? true;
  const signal = opts.signal;

  // 1) Cache hit path (validation-only, isolated from live HL cache).
  if (useCache) {
    const cached = readCachedSeries(coin, interval, lookbackDays);
    if (cached) {
      logger.info({ coin, interval, lookbackDays, bars: cached.bars.length }, "hl-validation: cache hit");
      return {
        coin, interval,
        bars: cached.bars,
        rawCount: cached.rawCount,
        windowStartMs: cached.windowStartMs,
        windowEndMs: cached.windowEndMs,
        source: "hyperliquid",
        cacheHit: true,
      };
    }
  }

  // 2) Network fetch path — paged HL candleSnapshot.
  const endMs = Date.now();
  const startMs = endMs - lookbackDays * 86_400_000;
  const oneBarMs = intervalToLookbackMs(interval, 1);
  const chunkMs = oneBarMs * MAX_BARS_PER_REQUEST;

  const seen = new Map<number, HlCandle>();
  let cursor = startMs;
  let pages = 0;
  while (cursor < endMs) {
    if (signal?.aborted) throw new Error("aborted");
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
      throw new FetchDeadlineError(seen.size);
    }
    const winEnd = Math.min(cursor + chunkMs, endMs);
    const page = await fetchCandlesRange(coin, interval, cursor, winEnd);
    pages++;
    if (page.length === 0) {
      cursor = winEnd;
      continue;
    }
    for (const c of page) seen.set(c.t, c);
    if (opts.onProgress) opts.onProgress(seen.size);
    const lastT = page[page.length - 1]!.t;
    cursor = Math.max(lastT + oneBarMs, cursor + oneBarMs);
    if (pages > 200) {
      logger.warn({ coin, interval, pages }, "hl-validation: bailing out of paging after 200 pages");
      break;
    }
  }

  const sorted = Array.from(seen.values()).sort((a, b) => a.t - b.t);
  const bars = candlesToOhlcv(sorted) as OhlcvBar[];
  const result: FetchedSeries = {
    coin, interval, bars, rawCount: sorted.length,
    windowStartMs: bars.length ? bars[0]!.time * 1000 : startMs,
    windowEndMs: bars.length ? bars[bars.length - 1]!.time * 1000 : endMs,
    source: "hyperliquid",
    cacheHit: false,
  };
  // 3) Best-effort write-through to the validation-only cache so future
  //    runs (and the re-kick flow) don't have to re-pay throttle cost.
  if (useCache && bars.length > 0) {
    writeCachedSeries({
      coin, interval, lookbackDays,
      windowStartMs: result.windowStartMs, windowEndMs: result.windowEndMs,
      rawCount: result.rawCount, bars,
      cachedAt: Date.now(),
      sourceHash: "", // overwritten by writer (kept for type)
    });
  }
  return result;
}
