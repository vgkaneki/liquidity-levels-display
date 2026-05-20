import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { scheduleNormalizedLevelsRefresh } from "./services/levelsHost";
import { fetchCandlesSourced } from "./services/candleSource";
import { primeCandleCache, warmUniverseCache } from "./routes/liquidity";
import { startMarketOverviewWarm } from "./services/marketOverview";
import { ensureSchema } from "@workspace/db";
import {
  loadRegistryFromDb,
  startRegistryPersistence,
} from "./services/levelRegistry/persistence";
import { startLiquidationPersistence } from "./services/liquidationHistory/persistence";
import { startWsHub } from "./services/wsHub";
import { startAlertEngine } from "./services/alertEngine";
import * as symbolRegistry from "./services/symbolRegistry";

// Pre-warm popular (symbol, interval) pairs so foreground requests stay
// cache-hot. The TtlCache keeps recomputing in the background every
// ~24s (0.8 × 30s TTL) so a foreground poll never has to wait.
const WARM: Array<[string, string]> = [
  ["BTCUSDT", "1H"], ["BTCUSDT", "4H"], ["BTCUSDT", "1D"],
  ["ETHUSDT", "1H"], ["ETHUSDT", "4H"], ["ETHUSDT", "1D"],
  ["SOLUSDT", "1H"], ["SOLUSDT", "4H"], ["SOLUSDT", "1D"],
  // Added 2026-04-23 based on telemetry: these symbols were the top
  // joined-inflight victims and consistently >4s on cold-miss when they
  // collided with the post-boot 429 window. Adding them to the boot warm
  // ensures their first user click is hot-hit.
  ["BNBUSDT", "1H"], ["BNBUSDT", "4H"], ["BNBUSDT", "1D"],
  ["XRPUSDT", "1H"], ["XRPUSDT", "4H"], ["XRPUSDT", "1D"],
  ["DOGEUSDT", "1H"], ["DOGEUSDT", "4H"], ["DOGEUSDT", "1D"],
  // Added 2026-04-23 (round 2) based on real-user telemetry showing
  // BTC 1m / 5m / 15m foreground requests waiting 25-49s. The user
  // actually trades on lower TFs, so warming them collapses the cold-
  // path /api/levels compute to a hot-hit on the route's SWR layer.
  ["BTCUSDT", "5m"], ["BTCUSDT", "15m"],
  ["ETHUSDT", "5m"], ["ETHUSDT", "15m"],
  ["SOLUSDT", "5m"], ["SOLUSDT", "15m"],
  // Added 2026-04-23 (round 3): post-DOM-removal probes confirmed 1m was
  // the last common TF still hitting the 15s cold-path cap on first visit.
  // Adding BTC/ETH/SOL × 1m closes the warm-list gap on the user's actual
  // lower-TF trading flow.
  ["BTCUSDT", "1m"], ["ETHUSDT", "1m"], ["SOLUSDT", "1m"],
  // Added 2026-04-23 (round 4 — P2 from full audit): the top-3 watchlist
  // symbols beyond BTC/ETH/SOL were already warmed on 1H/4H/1D but cold
  // on lower TFs. Real-user usage during the audit showed BNBUSDT cold-
  // miss in the candles log. Symmetric-warming the same 1m/5m/15m grid
  // we have for the majors so a click on any top-6 watchlist token at
  // any common TF is a hot-hit.
  ["BNBUSDT", "1m"], ["BNBUSDT", "5m"], ["BNBUSDT", "15m"],
  ["XRPUSDT", "1m"], ["XRPUSDT", "5m"], ["XRPUSDT", "15m"],
  ["DOGEUSDT", "1m"], ["DOGEUSDT", "5m"], ["DOGEUSDT", "15m"],
  // Added 2026-04-23 (round 5 — chart-load reliability emergency fix):
  // The Markets page top-liquidity table consistently surfaces these
  // names alongside the majors. Pre-warming candle cache on the most
  // common chart timeframes (1H/4H/1D) for these symbols ensures that
  // the very first visit to any of them is a hot-hit on the candle
  // route, eliminating the single user-visible cold-load entirely for
  // the realistic top-of-funnel symbol set.
  ["AAVEUSDT", "1H"], ["AAVEUSDT", "4H"], ["AAVEUSDT", "1D"],
  ["ADAUSDT", "1H"], ["ADAUSDT", "4H"], ["ADAUSDT", "1D"],
  ["LINKUSDT", "1H"], ["LINKUSDT", "4H"], ["LINKUSDT", "1D"],
  ["AVAXUSDT", "1H"], ["AVAXUSDT", "4H"], ["AVAXUSDT", "1D"],
  ["LTCUSDT", "1H"], ["LTCUSDT", "4H"], ["LTCUSDT", "1D"],
  ["BCHUSDT", "1H"], ["BCHUSDT", "4H"], ["BCHUSDT", "1D"],
];

// ms-per-bar lookup matching the candleSource interval alphabet (lowercase
// HL-native strings). Used by the candle warm-up to size `lookbackMs` so
// the warmed cache key matches the one /api/liquidity/candles will look up
// on the user's first click for the same pair.
const HL_BAR_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
  "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
};

// startupPerformanceV2: boot warmups are opt-in. A broad static warm list can
// create Hyperliquid/OKX/Toobit pressure during Render cold starts and compete
// with the user's foreground chart. Default is zero boot warm jobs. Operators
// can enable a tiny critical set or explicit pairs when needed. Infrastructure
// scheduling only; protected level formulas, scoring, confluence, DOM, Bookmap,
// absorption, touch classification, and level placement rules are untouched.
const ENABLE_FULL_BOOT_WARM = process.env["ENABLE_FULL_BOOT_WARM"] === "1";
const ENABLE_CRITICAL_BOOT_WARM = process.env["ENABLE_CRITICAL_BOOT_WARM"] === "1";
const BOOT_WARM_STEP_MS = Math.max(
  2_500,
  Number(process.env["BOOT_WARM_STEP_MS"] ?? "8000") || 8_000,
);
const BOOT_WARM_CANDLE_BARS = Math.min(
  1_500,
  Math.max(300, Number(process.env["BOOT_WARM_CANDLE_BARS"] ?? "700") || 700),
);
const CRITICAL_BOOT_WARM = new Set([
  "BTCUSDT|1m", "BTCUSDT|5m", "BTCUSDT|15m",
  "ETHUSDT|1m", "ETHUSDT|5m", "ETHUSDT|15m",
  "SOLUSDT|1m", "SOLUSDT|5m", "SOLUSDT|15m",
]);

// backgroundWorkloadV2: defer non-critical warmers until after the app shell
// and active chart have had a chance to load. These are scheduling/caching
// controls only; they do not touch engine formulas, scoring, confluence,
// DOM logic, Bookmap logic, absorption, touch classification, or level
// placement. Default market-overview warming is opt-in because it can compete
// with the selected chart during Render cold starts.
const BACKGROUND_START_DELAY_MS = Math.max(
  0,
  Number(process.env["BACKGROUND_START_DELAY_MS"] ?? "60000") || 60_000,
);
const ENABLE_BOOT_WARM = process.env["ENABLE_BOOT_WARM"] === "1";
const ENABLE_UNIVERSE_WARM = process.env["ENABLE_UNIVERSE_WARM"] !== "0";
const ENABLE_MARKET_OVERVIEW_WARM = process.env["ENABLE_MARKET_OVERVIEW_WARM"] === "1";
function parseBootWarmPairs(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const pairs: Array<[string, string]> = [];
  for (const token of raw.split(/[;,]/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [symRaw, tfRaw] = trimmed.split(/[|:]/);
    const sym = (symRaw ?? "").trim().replace(/[-_]/g, "").toUpperCase();
    const tf = (tfRaw ?? "").trim();
    if (!sym || !tf) continue;
    pairs.push([sym, tf]);
  }
  return pairs;
}
const EXPLICIT_BOOT_WARM = parseBootWarmPairs(process.env["BOOT_WARM_PAIRS"]);

const rawPort = process.env["PORT"] ?? (process.env.NODE_ENV === "production" ? undefined : "5000");

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required in production but was not provided.",
  );
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);

// serverLifecycleHardeningV1: explicit network timeouts and graceful shutdown
// for production runtime safety. Transport/process lifecycle only.
function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

httpServer.requestTimeout = boundedIntEnv("SERVER_REQUEST_TIMEOUT_MS", 30_000, 5_000, 120_000);
httpServer.headersTimeout = boundedIntEnv("SERVER_HEADERS_TIMEOUT_MS", 35_000, 5_000, 125_000);
httpServer.keepAliveTimeout = boundedIntEnv("SERVER_KEEPALIVE_TIMEOUT_MS", 5_000, 1_000, 60_000);

async function bootstrap(): Promise<void> {
  // Persistence is part of the realtime contract: the registry must be
  // loaded BEFORE we start accepting connections so a freshly-restarted
  // instance never serves a request from a cold cache. We fail-fast here
  // rather than silently degrade — the alternative is a server that
  // accepts traffic, hands out empty level snapshots, and then quietly
  // discards every level that the orchestrator detects.
  await ensureSchema();
  logger.info("db: schema ensured");
  await loadRegistryFromDb();
  startRegistryPersistence();
  // Liquidation log persistence — buffered writer + nightly prune. The WS
  // clients enqueue every event, so this must be running before
  // startLiveMarketData() boots the liq-WS connections (which happens
  // lazily on first /liquidity request via startLiveMarketData).
  startLiquidationPersistence();
  // NOTE: per-user default watchlists are seeded lazily — on
  // /api/auth/register and on the first /api/watchlists GET.
  // The legacy single-shared-default seed has been removed; pre-auth
  // rows in the watchlists table remain in the DB but are unreachable
  // by the per-user route layer.
}

async function start(): Promise<void> {
  // Hydrate the persistent level registry BEFORE we start serving traffic so
  // a freshly-restarted instance never serves a request from a cold registry.
  // ensureSchema is idempotent. Failure here is fatal — the rest of the
  // realtime stack assumes the registry is loaded.
  await bootstrap();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.off("error", reject);
      logger.info({ port }, "Server listening");
      resolve();
    });
  });

  // SymbolRegistry — Phase 1 source of truth for symbol normalization,
  // listing, native mapping, and routing. Eager parallel fetch with a
  // 3 s ceiling; any adapter that misses the window starts as "unknown"
  // and fills in on its first interval tick. Background timers are
  // unref()'d so they never block process exit.
  await symbolRegistry.start();
  startWsHub(httpServer);
  startAlertEngine();
  // Background cache work is delayed so the active chart and app shell are not
  // competing with universe/overview warmers during cold start.
  setTimeout(() => {
    if (ENABLE_UNIVERSE_WARM) {
      void warmUniverseCache();
    } else {
      logger.info("universe warm disabled");
    }
    if (ENABLE_MARKET_OVERVIEW_WARM) {
      startMarketOverviewWarm();
    } else {
      logger.info("market overview warm disabled by default");
    }
  }, BACKGROUND_START_DELAY_MS).unref();
  // Stagger the boot warm list with a small jitter so the engine's recursive
  // HTF + peer-symbol fan-out doesn't all hit Hyperliquid in one burst (which
  // was triggering 429s and persistent /api/levels 502s for half the symbols
  // for the next several minutes). 250ms × 8 entries spreads the wave over
  // ~2s — well under the user's first interaction.
  // Warm priority — lower TFs of the most-traded majors go FIRST so the
  // user's first click on a 1m/5m/15m chart of BTC/ETH/SOL never hits
  // the cold-path. Without this re-ordering the warm list was processed
  // in declaration order and the lower-TF entries (added in later rounds)
  // landed near the END of the 81 s fan-out — meaning a fast post-boot
  // navigation to BTC 1m would race the warm-up and could lose,
  // surfacing as a 502 under HL 429 backoff. Sort by (TF tier, symbol
  // tier) so the critical-path entries fire in the first ~10 s.
  const TF_PRIORITY: Record<string, number> = {
    "1m": 0, "5m": 1, "15m": 2, "30m": 3,
    "1H": 4, "1h": 4, "2H": 5, "2h": 5, "4H": 6, "4h": 6,
    "8H": 7, "8h": 7, "12H": 8, "12h": 8, "1D": 9, "1d": 9,
  };
  const SYM_PRIORITY: Record<string, number> = {
    BTCUSDT: 0, ETHUSDT: 1, SOLUSDT: 2,
    BNBUSDT: 3, XRPUSDT: 4, DOGEUSDT: 5,
  };
  const bootWarmSource = ENABLE_FULL_BOOT_WARM
    ? WARM
    : EXPLICIT_BOOT_WARM.length > 0
      ? EXPLICIT_BOOT_WARM
      : ENABLE_CRITICAL_BOOT_WARM
        ? WARM.filter(([sym, tf]) => CRITICAL_BOOT_WARM.has(`${sym}|${tf}`))
        : [];
  logger.info({
    mode: ENABLE_FULL_BOOT_WARM ? "full" : EXPLICIT_BOOT_WARM.length > 0 ? "explicit" : ENABLE_CRITICAL_BOOT_WARM ? "critical" : "off",
    count: bootWarmSource.length,
    stepMs: BOOT_WARM_STEP_MS,
    candleBars: BOOT_WARM_CANDLE_BARS,
  }, "startup warm: configured");
  const orderedWarm = [...bootWarmSource].sort((a, b) => {
    const ta = TF_PRIORITY[a[1]] ?? 99;
    const tb = TF_PRIORITY[b[1]] ?? 99;
    if (ta !== tb) return ta - tb;
    const sa = SYM_PRIORITY[a[0]] ?? 99;
    const sb = SYM_PRIORITY[b[0]] ?? 99;
    return sa - sb;
  });
  orderedWarm.forEach(([sym, tf], idx) => {
    setTimeout(() => {
      try {
        scheduleNormalizedLevelsRefresh(sym, tf);
      } catch (e) {
        logger.warn({ err: e, sym, tf }, "structural-levels warm scheduling failed");
      }
      // Also warm the candleSource cache for the same (symbol, interval).
      // The /api/liquidity/candles route memoizes its responses against
      // this cache, so warming it lets a user's first click on one of
      // these popular pairs render historical bars without a cold-path
      // round-trip to Hyperliquid. Best-effort — failures are logged
      // and never block the structural warm above.
      try {
        const coin = sym.replace(/USDT?$/, "");
        const hlInterval = tf.toLowerCase(); // "1H" -> "1h" matches HL/candleSource alphabet
        const barMs = HL_BAR_MS[hlInterval] ?? 3_600_000;
        // CRITICAL — chart-load reliability fix (April 2026):
        // The chart UI requests limit=10000 (HeatmapChart.tsx:1602), the
        // scanner uses limit=200, and engine refreshes use various sizes.
        // The route cache is keyed on `${sym}|${bar}|${lim}` so a warmed
        // entry at lim=200 was a CACHE MISS for the chart (lim=10000),
        // negating the warm-up entirely for the user-facing chart load.
        // We now warm with the chart's bar-count, AND the route lookup
        // is subset-tolerant (see candleCacheLookup() below) so the same
        // entry serves all smaller-limit consumers via slicing.
        // Hyperliquid's snapshot endpoint caps single-call returns at
        // ~5000 bars regardless of lookback, so asking for 10000 just
        // wastes upstream and triggers 429 when the warm-up fans out
        // across 54 (sym,tf) entries at boot. 5000 is plenty for the
        // chart's typical zoom-out and matches what HL actually returns.
        const WARM_BARS = BOOT_WARM_CANDLE_BARS;
        const lookbackMs = barMs * WARM_BARS;
        void fetchCandlesSourced(coin, hlInterval, lookbackMs)
          .then((sourced) => {
            try {
              primeCandleCache(sym, tf, sourced, WARM_BARS);
            } catch (e) {
              logger.warn({ err: e, sym, tf }, "candle route-cache prime failed");
            }
          })
          .catch((e) => {
            logger.warn({ err: e, sym, tf }, "candle warm failed");
          });
      } catch (e) {
        logger.warn({ err: e, sym, tf }, "candle warm scheduling failed");
      }
      // Spread the warm-up fan-out so the heavier 5000-bar fetches
      // don't slam Hyperliquid all at once and trigger 429 cascades
      // that starve foreground requests for the popular symbols.
      // 54 entries × 1500ms ≈ 81s — well under the chart's
      // stale-while-revalidate window so no UX impact, but gentle
      // enough on HL to avoid rate-limit blowback.
    }, BACKGROUND_START_DELAY_MS + idx * BOOT_WARM_STEP_MS).unref();
  });
}

let shutdownStarted = false;

function shutdown(signal: string): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info({ signal }, "server shutdown started");
  const forceTimer = setTimeout(() => {
    logger.error({ signal }, "server shutdown timed out");
    process.exit(1);
  }, boundedIntEnv("SERVER_SHUTDOWN_TIMEOUT_MS", 10_000, 1_000, 60_000));
  forceTimer.unref();
  httpServer.close((err) => {
    if (err) {
      logger.error({ err, signal }, "server shutdown failed");
      process.exit(1);
    }
    logger.info({ signal }, "server shutdown complete");
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException");
});

void start().catch((err) => {
  logger.error({ err }, "fatal: failed to start server");
  process.exit(1);
});

httpServer.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
