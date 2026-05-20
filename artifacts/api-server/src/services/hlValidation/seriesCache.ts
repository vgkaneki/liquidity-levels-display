// VALIDATION-ONLY historical candle cache.
//
// HARD ISOLATION:
//   - This cache lives on disk under reports/hl-validation/cache/ and is
//     used ONLY by the validation suite's dataFetcher.
//   - It NEVER reads from or writes to the live HL TtlCache / orderbook
//     cache / candle cache that the production engine uses.
//   - It NEVER causes a fallback to OKX / Toobit / KCEX / synthetic data.
//     A miss simply means the dataFetcher must do a real HL paged fetch
//     (the existing path).
//   - Cache key includes (coin, interval, lookbackDays, source-hash) and
//     entries older than CACHE_TTL_MS are ignored on read.
//
// On a hit, the run's report discloses which series came from cache so the
// reader can tell the difference between freshly-fetched HL data and
// disk-cached HL data. Source remains "hyperliquid" in either case.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OhlcvBar } from "../engines/levels";

export interface CachedSeriesPayload {
  coin: string;
  interval: string;
  lookbackDays: number;
  windowStartMs: number;
  windowEndMs: number;
  rawCount: number;
  bars: OhlcvBar[];
  cachedAt: number;
  sourceHash: string;
}

const SOURCE = "hyperliquid";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;     // 24h — re-fetch daily
const CACHE_VERSION = "v1";

function cacheRootDir(): string {
  const reportsDir = process.env.HL_VALIDATION_REPORTS_DIR
    ?? join(process.cwd(), "reports", "hl-validation");
  return join(reportsDir, "cache", CACHE_VERSION);
}

function sourceHash(coin: string, interval: string, lookbackDays: number): string {
  return createHash("sha256")
    .update(`${SOURCE}|${coin}|${interval}|${lookbackDays}|${CACHE_VERSION}`)
    .digest("hex").slice(0, 16);
}

function cacheFilePath(coin: string, interval: string, lookbackDays: number): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const h = sourceHash(coin, interval, lookbackDays);
  return join(cacheRootDir(), `${safe(coin)}_${safe(interval)}_${lookbackDays}d_${h}.json`);
}

export function readCachedSeries(
  coin: string,
  interval: string,
  lookbackDays: number,
): CachedSeriesPayload | null {
  try {
    const p = cacheFilePath(coin, interval, lookbackDays);
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    const raw = readFileSync(p, "utf8");
    const obj = JSON.parse(raw) as CachedSeriesPayload;
    if (!obj || obj.coin !== coin || obj.interval !== interval) return null;
    if (obj.lookbackDays !== lookbackDays) return null;
    if (obj.sourceHash !== sourceHash(coin, interval, lookbackDays)) return null;
    if (!Array.isArray(obj.bars) || obj.bars.length === 0) return null;
    return obj;
  } catch {
    return null;
  }
}

export function writeCachedSeries(payload: CachedSeriesPayload): void {
  try {
    mkdirSync(cacheRootDir(), { recursive: true });
    const p = cacheFilePath(payload.coin, payload.interval, payload.lookbackDays);
    const filled: CachedSeriesPayload = {
      ...payload,
      cachedAt: payload.cachedAt || Date.now(),
      sourceHash: sourceHash(payload.coin, payload.interval, payload.lookbackDays),
    };
    writeFileSync(p, JSON.stringify(filled), "utf8");
  } catch {
    // cache write failures are non-fatal — dataFetcher will simply re-fetch next run
  }
}

export function describeCacheRoot(): string {
  return cacheRootDir();
}
