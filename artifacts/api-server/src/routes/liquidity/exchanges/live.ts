import { logger } from "../../../lib/logger";
import * as okx from "./okx";
import * as hl from "./hyperliquid";
import { okxStore, hlStore, touch, pin } from "./ws-store";
import {
  startOkxWs,
  ensureSubscribed as okxSub,
  getOkxWsHealth,
  isOkxWsHealthy,
} from "./okx-ws";
import {
  startHlWs,
  ensureSubscribed as hlSub,
  getHlWsHealth,
  isHlWsHealthy,
} from "./hl-ws";
import { startOkxLiqWs, getOkxLiqWsHealth } from "./okx-liq-ws";
import { startHlLiqWs, getHlLiqWsHealth } from "./hl-liq-ws";
import { startBybitLiqWs, getBybitLiqWsHealth } from "./bybit-liq-ws";
import { startBinanceLiqWs, getBinanceLiqWsHealth } from "./binance-liq-ws";

// Per-channel freshness ceilings in ms. Above this age we only trust the
// cache while the WS is healthy; if the WS is unhealthy we force a one-shot
// REST refresh so the API never serves indefinitely stale data during long
// disconnects. Funding/OI push less often, so their ceilings are larger.
const CEIL_BOOK_MS = 30_000;
const CEIL_TICKER_MS = 30_000;
const CEIL_FUNDING_MS = 30 * 60_000;
const CEIL_OI_MS = 5 * 60_000;
const CEIL_HL_BOOK_MS = 30_000;
const CEIL_HL_ASSET_MS = 30_000;

function tooStale(age: number | null, ceiling: number, healthy: boolean): boolean {
  if (age === null) return true;
  if (healthy) return false;
  return age > ceiling;
}

// --- Negative cache: per-exchange supported-symbol universes ---
//
// Both OKX and HL publish the full list of tradable symbols. We cache that
// universe and refuse to issue REST bootstrap calls for symbols outside it,
// so an HL-only coin never triggers OKX REST traffic (and vice versa). The
// universe is refreshed on a TTL so newly listed symbols get picked up.
const UNIVERSE_TTL_MS = 60 * 60_000;
const ENABLE_LIVE_BOOT_REST_WARM = process.env.ENABLE_LIVE_BOOT_REST_WARM === "1"; // liveRestWarmOptInV1

interface UniverseCache {
  set: Set<string>;
  loadedAt: number;
}

let okxUniverse: UniverseCache | null = null;
let okxUniverseInflight: Promise<Set<string> | null> | null = null;
let hlUniverse: UniverseCache | null = null;
let hlUniverseInflight: Promise<Set<string> | null> | null = null;

function toHlSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

async function getOkxUniverse(): Promise<Set<string> | null> {
  if (okxUniverse && Date.now() - okxUniverse.loadedAt < UNIVERSE_TTL_MS) {
    return okxUniverse.set;
  }
  if (okxUniverseInflight) return okxUniverseInflight;
  okxUniverseInflight = (async () => {
    const instruments = await okx.fetchInstruments();
    if (!instruments) return okxUniverse?.set ?? null;
    const set = new Set(instruments.map((i) => i.symbol));
    okxUniverse = { set, loadedAt: Date.now() };
    return set;
  })().finally(() => {
    okxUniverseInflight = null;
  });
  return okxUniverseInflight;
}

async function getHlUniverse(): Promise<Set<string> | null> {
  if (hlUniverse && Date.now() - hlUniverse.loadedAt < UNIVERSE_TTL_MS) {
    return hlUniverse.set;
  }
  if (hlUniverseInflight) return hlUniverseInflight;
  hlUniverseInflight = (async () => {
    const all = await hl.fetchAllAssets();
    if (!all) return hlUniverse?.set ?? null;
    const set = new Set(Array.from(all.keys()).map(toHlSymbol));
    hlUniverse = { set, loadedAt: Date.now() };
    return set;
  })().finally(() => {
    hlUniverseInflight = null;
  });
  return hlUniverseInflight;
}

async function isOkxSupported(symbol: string): Promise<boolean> {
  const u = await getOkxUniverse();
  // Universe unknown (network failure on first probe): allow the bootstrap
  // through so we don't permanently break things during an outage.
  if (!u) return true;
  return u.has(symbol);
}

async function isHlSupported(symbol: string): Promise<boolean> {
  const u = await getHlUniverse();
  if (!u) return true;
  return u.has(symbol);
}

// --- Per-field bootstrap ---
//
// We fetch each REST field independently (book/ticker/funding/oi for OKX and
// book/asset for HL) so we never re-fetch fields that are already populated
// from WS. Concurrent callers for the same (symbol, field) share one inflight
// request.
type OkxField = "book" | "ticker" | "funding" | "oi";
type HlField = "book" | "asset";

const inflightOkx = new Map<string, Promise<void>>();
const inflightHl = new Map<string, Promise<void>>();

// --- Per-(exchange,symbol,endpoint) failure backoff ---
//
// When a REST fetch returns null or throws, we keep a short cooldown for that
// exact (exchange, symbol, field) tuple before allowing another attempt. The
// cooldown grows exponentially up to a 5-minute ceiling so a persistently
// failing endpoint stops generating traffic and error spam, while:
//   - other symbols and other endpoints on the same exchange keep working
//   - a single recovered call resets the entry, restoring full speed
//   - the entry naturally expires, so the failure is never permanent
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

interface BackoffEntry {
  failures: number;
  cooldownUntil: number;
}
const backoff = new Map<string, BackoffEntry>();

function backoffKey(exchange: "okx" | "hl", symbol: string, field: string): string {
  return `${exchange}:${symbol}:${field}`;
}

function inCooldown(key: string): boolean {
  const e = backoff.get(key);
  return !!e && Date.now() < e.cooldownUntil;
}

function recordSuccess(key: string): void {
  if (backoff.delete(key)) {
    logger.debug({ key }, "live: backoff cleared after success");
  }
}

function recordFailure(key: string): void {
  const e = backoff.get(key) ?? { failures: 0, cooldownUntil: 0 };
  e.failures += 1;
  const delay = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_INITIAL_MS * Math.pow(2, e.failures - 1),
  );
  e.cooldownUntil = Date.now() + delay;
  backoff.set(key, e);
  logger.debug({ key, failures: e.failures, cooldownMs: delay }, "live: backoff applied");
}

async function ensureOkxField(symbol: string, field: OkxField): Promise<void> {
  if (!(await isOkxSupported(symbol))) {
    logger.debug(
      { exchange: "okx", symbol, field },
      "live: skipping OKX REST bootstrap, symbol not in universe",
    );
    return;
  }
  const bk = backoffKey("okx", symbol, field);
  if (inCooldown(bk)) return;
  const key = `${symbol}:${field}`;
  const existing = inflightOkx.get(key);
  if (existing) return existing;
  const p = (async () => {
    let ok = false;
    try {
      if (field === "book") {
        const v = await okx.fetchOrderbook(symbol, 300);
        if (v) {
          okxStore.setBook(symbol, v);
          ok = true;
        }
      } else if (field === "ticker") {
        const v = await okx.fetchTicker(symbol);
        if (v) {
          okxStore.setTicker(symbol, v);
          ok = true;
        }
      } else if (field === "funding") {
        const v = await okx.fetchFunding(symbol);
        if (v) {
          okxStore.setFunding(symbol, v);
          ok = true;
        }
      } else {
        const v = await okx.fetchOpenInterest(symbol);
        if (v) {
          okxStore.setOI(symbol, v);
          ok = true;
        }
      }
    } finally {
      if (ok) recordSuccess(bk);
      else recordFailure(bk);
    }
  })().finally(() => {
    inflightOkx.delete(key);
  });
  inflightOkx.set(key, p);
  return p;
}

async function ensureHlField(symbol: string, field: HlField): Promise<void> {
  if (!(await isHlSupported(symbol))) {
    logger.debug(
      { exchange: "hl", symbol, field },
      "live: skipping HL REST bootstrap, symbol not in universe",
    );
    return;
  }
  const bk = backoffKey("hl", symbol, field);
  if (inCooldown(bk)) return;
  const key = `${symbol}:${field}`;
  const existing = inflightHl.get(key);
  if (existing) return existing;
  const p = (async () => {
    let ok = false;
    try {
      if (field === "book") {
        const v = await hl.fetchOrderbook(symbol);
        if (v) {
          hlStore.setBook(symbol, v);
          ok = true;
        }
      } else {
        const v = await hl.fetchAsset(symbol);
        if (v) {
          hlStore.setAsset(symbol, v);
          ok = true;
        }
      }
    } finally {
      if (ok) recordSuccess(bk);
      else recordFailure(bk);
    }
  })().finally(() => {
    inflightHl.delete(key);
  });
  inflightHl.set(key, p);
  return p;
}

function touchAndSub(symbol: string): void {
  touch(symbol);
  // okxSub already filters unsupported symbols using the WS-side universe
  // cache (see okx-ws.ts), so we always call it here and let it decide.
  okxSub(symbol);
  hlSub(symbol);
}

// Public touch — used by routes that don't directly read a per-symbol value
// (e.g. /liquidity/candles) but should still keep the symbol in the active
// set so its WS subscription doesn't get evicted.
export function touchSymbol(symbol: string): void {
  touchAndSub(symbol);
}

export async function getOkxOrderbook(symbol: string) {
  touchAndSub(symbol);
  if (!(await isOkxSupported(symbol))) return null;
  if (tooStale(okxStore.bookAge(symbol), CEIL_BOOK_MS, isOkxWsHealthy())) {
    await ensureOkxField(symbol, "book");
  }
  return okxStore.getBook(symbol);
}

export async function getOkxTicker(symbol: string) {
  touchAndSub(symbol);
  if (!(await isOkxSupported(symbol))) return null;
  if (tooStale(okxStore.tickerAge(symbol), CEIL_TICKER_MS, isOkxWsHealthy())) {
    await ensureOkxField(symbol, "ticker");
  }
  return okxStore.getTicker(symbol);
}

export async function getOkxFunding(symbol: string) {
  touchAndSub(symbol);
  if (!(await isOkxSupported(symbol))) return null;
  if (tooStale(okxStore.fundingAge(symbol), CEIL_FUNDING_MS, isOkxWsHealthy())) {
    await ensureOkxField(symbol, "funding");
  }
  return okxStore.getFunding(symbol);
}

export async function getOkxOI(symbol: string) {
  touchAndSub(symbol);
  if (!(await isOkxSupported(symbol))) return null;
  if (tooStale(okxStore.oiAge(symbol), CEIL_OI_MS, isOkxWsHealthy())) {
    await ensureOkxField(symbol, "oi");
  }
  return okxStore.getOI(symbol);
}

export async function getHlOrderbook(symbol: string) {
  touchAndSub(symbol);
  if (tooStale(hlStore.bookAge(symbol), CEIL_HL_BOOK_MS, isHlWsHealthy())) {
    await ensureHlField(symbol, "book");
  }
  return hlStore.getBook(symbol);
}

export async function getHlAsset(symbol: string) {
  touchAndSub(symbol);
  if (tooStale(hlStore.assetAge(symbol), CEIL_HL_ASSET_MS, isHlWsHealthy())) {
    await ensureHlField(symbol, "asset");
  }
  return hlStore.getAsset(symbol);
}

export function startLiveMarketData(scannerSymbols: string[]): void {
  startOkxWs();
  startHlWs();
  startOkxLiqWs();
  startHlLiqWs();
  startBybitLiqWs();
  startBinanceLiqWs();
  // Analytics sampler runs alongside the price/liquidation feeds; samples
  // every 5s into bounded ring buffers used by /liquidity/analytics/:symbol.
  void import("../analytics-store").then((m) => m.startAnalyticsSampler());
  // Warm the universe caches up-front so the first per-symbol probes don't
  // trigger redundant REST work.
  void getOkxUniverse();
  void getHlUniverse();
  for (const s of scannerSymbols) {
    pin(s);
    okxSub(s);
    hlSub(s);
    if (ENABLE_LIVE_BOOT_REST_WARM) {
      void ensureOkxField(s, "book").catch(() => {});
      void ensureOkxField(s, "ticker").catch(() => {});
      void ensureOkxField(s, "funding").catch(() => {});
      void ensureOkxField(s, "oi").catch(() => {});
      void ensureHlField(s, "book").catch(() => {});
      void ensureHlField(s, "asset").catch(() => {});
    }
  }
}

export function getLiveHealth() {
  return {
    okx: {
      ...getOkxWsHealth(),
      universeSize: okxUniverse?.set.size ?? null,
      universeAgeMs: okxUniverse ? Date.now() - okxUniverse.loadedAt : null,
    },
    hl: {
      ...getHlWsHealth(),
      universeSize: hlUniverse?.set.size ?? null,
      universeAgeMs: hlUniverse ? Date.now() - hlUniverse.loadedAt : null,
    },
    okxLiquidations: getOkxLiqWsHealth(),
    hlLiquidations: getHlLiqWsHealth(),
    bybitLiquidations: getBybitLiqWsHealth(),
    binanceLiquidations: getBinanceLiqWsHealth(),
  };
}
