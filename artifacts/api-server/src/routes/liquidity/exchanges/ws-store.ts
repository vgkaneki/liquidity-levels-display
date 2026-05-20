import type { OkxOrderbook, OkxTicker, OkxFunding, OkxOpenInterest } from "./okx";
import type { HlAssetCtx, HlOrderbook } from "./hyperliquid";

interface Stamped<T> { data: T; at: number }

// We intentionally do NOT gate reads on freshness. Once WS has populated the
// store, callers always read the last-known value — channels like funding/OI
// only push when they change, so a "stale" age does not mean stale data.
// Bootstrap-from-REST is gated on cache absence, not age (see live.ts).
const ACTIVE_TTL_MS = 5 * 60_000;

const okxBooks = new Map<string, Stamped<OkxOrderbook>>();
const okxTickers = new Map<string, Stamped<OkxTicker>>();
const okxFundings = new Map<string, Stamped<OkxFunding>>();
const okxOIs = new Map<string, Stamped<OkxOpenInterest>>();

const hlBooks = new Map<string, Stamped<HlOrderbook>>();
const hlAssets = new Map<string, Stamped<HlAssetCtx>>();

const lastTouch = new Map<string, number>();
const permanent = new Set<string>();

// Lightweight pub/sub for real-time book/ticker updates. The /ws hub
// subscribes here so it can fan-out heatmap/depth deltas without polling
// the maps. Listeners must be cheap — they run in the WS message hot path.
type BookListener = (
  exchange: "okx" | "hyperliquid",
  symbol: string,
) => void;
type TickerListener = (exchange: "okx" | "hyperliquid", symbol: string) => void;
const bookListeners = new Set<BookListener>();
const tickerListeners = new Set<TickerListener>();
export function subscribeBookUpdates(fn: BookListener): () => void {
  bookListeners.add(fn);
  return () => bookListeners.delete(fn);
}
export function subscribeTickerUpdates(fn: TickerListener): () => void {
  tickerListeners.add(fn);
  return () => tickerListeners.delete(fn);
}
function emitBook(exchange: "okx" | "hyperliquid", symbol: string): void {
  for (const fn of bookListeners) {
    try { fn(exchange, symbol); } catch { /* swallow */ }
  }
}
function emitTicker(exchange: "okx" | "hyperliquid", symbol: string): void {
  for (const fn of tickerListeners) {
    try { fn(exchange, symbol); } catch { /* swallow */ }
  }
}

export function touch(symbol: string): void {
  lastTouch.set(symbol, Date.now());
}

export function pin(symbol: string): void {
  permanent.add(symbol);
  lastTouch.set(symbol, Date.now());
}

export function isActive(symbol: string): boolean {
  if (permanent.has(symbol)) return true;
  const t = lastTouch.get(symbol);
  return t !== undefined && Date.now() - t < ACTIVE_TTL_MS;
}

export function listActive(): string[] {
  const now = Date.now();
  const out = new Set<string>(permanent);
  for (const [s, t] of lastTouch) {
    if (now - t < ACTIVE_TTL_MS) out.add(s);
  }
  return Array.from(out);
}

// Drop touch entries whose TTL has long-since expired so the map doesn't grow
// unbounded across unique-symbol churn. Permanent pins are never pruned.
export function pruneTouches(): void {
  const cutoff = Date.now() - ACTIVE_TTL_MS;
  for (const [s, t] of lastTouch) {
    if (permanent.has(s)) continue;
    if (t < cutoff) lastTouch.delete(s);
  }
}

function getEntry<T>(map: Map<string, Stamped<T>>, key: string): T | null {
  const e = map.get(key);
  return e ? e.data : null;
}

function ageOf<T>(map: Map<string, Stamped<T>>, key: string): number | null {
  const e = map.get(key);
  return e ? Date.now() - e.at : null;
}

function maxAge<T>(map: Map<string, Stamped<T>>): number | null {
  let oldest: number | null = null;
  const now = Date.now();
  for (const e of map.values()) {
    const age = now - e.at;
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

export const okxStore = {
  getBook: (s: string) => getEntry(okxBooks, s),
  getTicker: (s: string) => getEntry(okxTickers, s),
  getFunding: (s: string) => getEntry(okxFundings, s),
  getOI: (s: string) => getEntry(okxOIs, s),
  setBook: (s: string, b: OkxOrderbook) => {
    okxBooks.set(s, { data: b, at: Date.now() });
    emitBook("okx", s);
  },
  setTicker: (s: string, t: OkxTicker) => {
    okxTickers.set(s, { data: t, at: Date.now() });
    emitTicker("okx", s);
  },
  setFunding: (s: string, f: OkxFunding) => okxFundings.set(s, { data: f, at: Date.now() }),
  setOI: (s: string, o: OkxOpenInterest) => okxOIs.set(s, { data: o, at: Date.now() }),
  forget: (s: string) => {
    okxBooks.delete(s);
    okxTickers.delete(s);
    okxFundings.delete(s);
    okxOIs.delete(s);
  },
  size: () => ({
    books: okxBooks.size,
    tickers: okxTickers.size,
    fundings: okxFundings.size,
    ois: okxOIs.size,
  }),
  oldestAgeMs: () => maxAge(okxTickers),
  bookAge: (s: string) => ageOf(okxBooks, s),
  tickerAge: (s: string) => ageOf(okxTickers, s),
  fundingAge: (s: string) => ageOf(okxFundings, s),
  oiAge: (s: string) => ageOf(okxOIs, s),
  perSymbolAges: () => {
    const symbols = new Set<string>([
      ...okxBooks.keys(),
      ...okxTickers.keys(),
      ...okxFundings.keys(),
      ...okxOIs.keys(),
    ]);
    const out: Record<string, { book: number | null; ticker: number | null; funding: number | null; oi: number | null }> = {};
    for (const s of symbols) {
      out[s] = {
        book: ageOf(okxBooks, s),
        ticker: ageOf(okxTickers, s),
        funding: ageOf(okxFundings, s),
        oi: ageOf(okxOIs, s),
      };
    }
    return out;
  },
};

export const hlStore = {
  getBook: (s: string) => getEntry(hlBooks, s),
  getAsset: (s: string) => getEntry(hlAssets, s),
  setBook: (s: string, b: HlOrderbook) => {
    hlBooks.set(s, { data: b, at: Date.now() });
    emitBook("hyperliquid", s);
  },
  setAsset: (s: string, a: HlAssetCtx) => {
    hlAssets.set(s, { data: a, at: Date.now() });
    emitTicker("hyperliquid", s);
  },
  forget: (s: string) => {
    hlBooks.delete(s);
    hlAssets.delete(s);
  },
  size: () => ({ books: hlBooks.size, assets: hlAssets.size }),
  // Snapshot of every live HL asset entry currently held in the WS-fed
  // store. Used by the market-overview rollup so it doesn't have to wait
  // for the 30s `fetchAllAssets` REST cache to expire.
  listAssets: () => {
    const out = new Map<string, HlAssetCtx>();
    for (const [s, e] of hlAssets) out.set(s, e.data);
    return out;
  },
  oldestAgeMs: () => maxAge(hlAssets),
  bookAge: (s: string) => ageOf(hlBooks, s),
  assetAge: (s: string) => ageOf(hlAssets, s),
  perSymbolAges: () => {
    const symbols = new Set<string>([...hlBooks.keys(), ...hlAssets.keys()]);
    const out: Record<string, { book: number | null; asset: number | null }> = {};
    for (const s of symbols) {
      out[s] = { book: ageOf(hlBooks, s), asset: ageOf(hlAssets, s) };
    }
    return out;
  },
};
