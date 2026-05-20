// Persistent liquidation-event log.
//
// Writers: the okx-liq-ws and hl-liq-ws clients hand each newly-observed
// liquidation to `enqueueLiquidation`. Events are buffered in memory and
// flushed in batches every FLUSH_INTERVAL_MS to keep the hot WS path off
// the database. Duplicate ids (rare reconnect replays) are absorbed via
// ON CONFLICT DO NOTHING.
//
// Readers: `getClustersFromDb` runs the same log-space bucketing that the
// in-memory clusters endpoint does, but in SQL so we don't pull millions
// of rows into Node memory. The route delegates to this for windows that
// exceed the in-memory ring (~30 min retention, see okx-liq-ws.ts).
//
// Retention: a periodic prune drops rows older than RETENTION_MS (7d).

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, liquidationEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";

const FLUSH_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60_000; // hourly
const RETENTION_MS = 7 * 24 * 60 * 60_000; // 7 days
const MAX_BUFFER = 5_000;

export type LiquidationExchange = "okx" | "hyperliquid" | "bybit" | "binance";

export interface PersistableLiquidation {
  // The id field on the inbound event is the WS-layer id (often random
  // suffixed for React keys). It is intentionally NOT used as the DB
  // primary key — see `deterministicId` below.
  id: string;
  exchange: LiquidationExchange;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  ts: number;
}

interface PersistedRow {
  id: string;
  exchange: LiquidationExchange;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  ts: number;
}

// Short, unique prefix per exchange so the DB id stays human-skimmable.
// The hash already disambiguates collisions; this is purely cosmetic.
const ID_PREFIX: Record<LiquidationExchange, string> = {
  okx: "o",
  hyperliquid: "h",
  bybit: "by",
  binance: "bn",
};

let buffer: PersistedRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let totalInserted = 0;
let totalDropped = 0;

// Deterministic primary key: a short hash of the immutable identifying
// fields. Reconnect/replay duplicates collapse via ON CONFLICT DO NOTHING
// because the same liquidation always hashes to the same id, regardless
// of the random suffix the WS layer assigns to its in-memory event id.
function deterministicId(ev: PersistableLiquidation): string {
  const h = createHash("sha1");
  h.update(ev.exchange);
  h.update("|");
  h.update(ev.symbol);
  h.update("|");
  h.update(String(ev.ts));
  h.update("|");
  h.update(ev.side);
  h.update("|");
  h.update(ev.price.toString());
  h.update("|");
  h.update(ev.size.toString());
  return `${ID_PREFIX[ev.exchange]}-${h.digest("hex").slice(0, 24)}`;
}

function dropOldest(): void {
  buffer.shift();
  totalDropped++;
}

export function enqueueLiquidation(ev: PersistableLiquidation): void {
  if (!Number.isFinite(ev.price) || ev.price <= 0) return;
  if (!Number.isFinite(ev.usdValue) || ev.usdValue < 0) return;
  if (buffer.length >= MAX_BUFFER) {
    // Backpressure: drop the oldest pending row rather than unbounded
    // growth if the DB is unavailable. Operator visibility via stats.
    dropOldest();
  }
  buffer.push({
    id: deterministicId(ev),
    exchange: ev.exchange,
    symbol: ev.symbol,
    side: ev.side,
    price: ev.price,
    size: ev.size,
    usdValue: ev.usdValue,
    ts: ev.ts,
  });
}

async function flushOnce(): Promise<void> {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await db
      .insert(liquidationEventsTable)
      .values(
        batch.map((b) => ({
          id: b.id,
          exchange: b.exchange,
          symbol: b.symbol,
          side: b.side,
          price: b.price,
          size: b.size,
          usdValue: b.usdValue,
          ts: b.ts,
        })),
      )
      .onConflictDoNothing({ target: liquidationEventsTable.id });
    totalInserted += batch.length;
  } catch (err) {
    // Re-queue at the front so we don't lose events if Postgres is
    // briefly unavailable, then enforce a hard cap so a prolonged
    // outage cannot grow this buffer unboundedly. We deliberately drop
    // the OLDEST events first so the freshest data wins — older
    // liquidations decay out of the window-of-interest anyway.
    const merged = batch.concat(buffer);
    let dropped = 0;
    if (merged.length > MAX_BUFFER) {
      dropped = merged.length - MAX_BUFFER;
      merged.splice(0, dropped);
      totalDropped += dropped;
    }
    buffer = merged;
    logger.warn(
      {
        err: String(err),
        batch: batch.length,
        buffered: buffer.length,
        dropped,
      },
      "liquidationHistory: flush failed",
    );
  } finally {
    flushing = false;
  }
}

async function prune(): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    await db.execute(
      sql`DELETE FROM liquidation_events WHERE ts < ${cutoff}`,
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "liquidationHistory: prune failed");
  }
}

export function startLiquidationPersistence(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushOnce();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  pruneTimer = setInterval(() => {
    void prune();
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
  // First prune shortly after boot so a long-running deployment doesn't
  // wait an hour to reclaim its first chunk of expired rows.
  setTimeout(() => void prune(), 30_000).unref?.();
}

export function stopLiquidationPersistence(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function getLiquidationPersistenceStats() {
  return {
    buffered: buffer.length,
    totalInserted,
    totalDropped,
    retentionMs: RETENTION_MS,
  };
}

export interface DbClusterRow {
  symbol: string;
  bucketIdx: number;
  bucketLow: number;
  bucketHigh: number;
  bucketPrice: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
  okxCount: number;
  hlCount: number;
  bybitCount: number;
  binanceCount: number;
  lastTs: number;
}

/**
 * Aggregate persisted liquidations into log-space price buckets, matching
 * the in-memory bucketing in routes/liquidity/index.ts so callers see the
 * same shape regardless of which path served the request.
 */
export async function getClustersFromDb(opts: {
  symbols: string[];
  windowMs: number;
  bucketBps: number; // 1..200, equals 0.01% .. 2%
  minUsd: number;
  maxClusters: number;
}): Promise<DbClusterRow[]> {
  const { symbols, windowMs, bucketBps, minUsd, maxClusters } = opts;
  if (symbols.length === 0) return [];
  const cutoff = Date.now() - windowMs;
  const widthFrac = bucketBps / 10_000;
  const denom = Math.log(1 + widthFrac);

  // Flush any in-memory rows so a small race window between WS push and
  // the periodic flush doesn't drop them out of a long-window aggregation.
  // This is best-effort; getClustersFromDb tolerates a stale buffer.
  if (buffer.length > 0) {
    await flushOnce();
  }

  // Single-pass GROUP BY in SQL. price/usd_value are doubles so the
  // arithmetic stays in DB; we exponentiate the bucket bounds back out
  // in Node where the cast is trivial.
  const rows = await db.execute<{
    symbol: string;
    bucket_idx: number;
    long_usd: number;
    short_usd: number;
    total_usd: number;
    cnt: number;
    okx_count: number;
    hl_count: number;
    bybit_count: number;
    binance_count: number;
    last_ts: number;
  }>(sql`
    SELECT
      symbol,
      floor(ln(price) / ${denom})::int AS bucket_idx,
      SUM(CASE WHEN side = 'long' THEN usd_value ELSE 0 END) AS long_usd,
      SUM(CASE WHEN side = 'short' THEN usd_value ELSE 0 END) AS short_usd,
      SUM(usd_value) AS total_usd,
      COUNT(*)::int AS cnt,
      SUM(CASE WHEN exchange = 'okx' THEN 1 ELSE 0 END)::int AS okx_count,
      SUM(CASE WHEN exchange = 'hyperliquid' THEN 1 ELSE 0 END)::int AS hl_count,
      SUM(CASE WHEN exchange = 'bybit' THEN 1 ELSE 0 END)::int AS bybit_count,
      SUM(CASE WHEN exchange = 'binance' THEN 1 ELSE 0 END)::int AS binance_count,
      MAX(ts) AS last_ts
    FROM liquidation_events
    WHERE symbol IN (${sql.join(
      symbols.map((s) => sql`${s}`),
      sql`,`,
    )})
      AND ts >= ${cutoff}
      AND price > 0
    GROUP BY symbol, bucket_idx
    HAVING SUM(usd_value) >= ${minUsd}
    ORDER BY total_usd DESC
    LIMIT ${maxClusters}
  `);

  // node-postgres returns rows under .rows for raw .execute().
  const list = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];

  return list.map((r) => {
    const idx = Number(r.bucket_idx);
    const bucketLow = Math.pow(1 + widthFrac, idx);
    const bucketHigh = Math.pow(1 + widthFrac, idx + 1);
    return {
      symbol: String(r.symbol),
      bucketIdx: idx,
      bucketLow,
      bucketHigh,
      bucketPrice: (bucketLow + bucketHigh) / 2,
      longUsd: Number(r.long_usd),
      shortUsd: Number(r.short_usd),
      totalUsd: Number(r.total_usd),
      count: Number(r.cnt),
      okxCount: Number(r.okx_count),
      hlCount: Number(r.hl_count),
      bybitCount: Number(r.bybit_count),
      binanceCount: Number(r.binance_count),
      lastTs: Number(r.last_ts),
    };
  });
}
