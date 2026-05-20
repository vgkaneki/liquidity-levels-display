import { getCached, setCache } from "./cache";
import * as symbolRegistry from "../../../services/symbolRegistry";
import { logDisagreement } from "../../../services/symbolRegistry/disagreementLog";

const BASE = "https://api.hyperliquid.xyz/info";
const META_TTL = 30000;
const BOOK_TTL = 3000;

async function postJson<T>(body: Record<string, unknown>): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toHlCoinUpper(symbol: string): string {
  return symbol.replace(/-/g, "").replace(/USDT$/, "").toUpperCase();
}

// Hyperliquid's API is case-sensitive: kilo-perps are named "kPEPE",
// "kSHIB", etc. (lowercase k). The UI universe canonicalizes everything
// to uppercase ("KPEPEUSDT"), so we have to translate back to the exact
// casing HL expects before issuing REST calls or WS subscriptions —
// otherwise HL returns nothing and the symbol falls through to synthetic
// data. The lookup table is rebuilt whenever fetchAllAssets refreshes
// the meta cache.
let upperToOrigCoin: Map<string, string> = new Map();

/**
 * Translate a UI symbol like "KPEPEUSDT" into HL's native coin name
 * ("kPEPE"). Returns null if HL doesn't list it (caller should fall
 * through to the next exchange tier).
 */
export async function resolveHlCoin(symbol: string): Promise<string | null> {
  // Phase 1 SymbolRegistry — primary path. Falls back to legacy lookup
  // table if the registry doesn't know the symbol yet (cold-boot window
  // or genuinely unknown). Disagreement is logged for visibility.
  const fromRegistry = symbolRegistry.toNative(symbol, "hl");
  if (fromRegistry) return fromRegistry;
  const upper = toHlCoinUpper(symbol);
  if (upperToOrigCoin.size === 0) {
    await fetchAllAssets();
  }
  const fromLegacy = upperToOrigCoin.get(upper) ?? null;
  if (fromLegacy && symbolRegistry.isListed(symbol, "hl") === "yes") {
    logDisagreement("resolveHlCoin", symbol, fromRegistry, fromLegacy);
  }
  return fromLegacy;
}

/**
 * Synchronous variant for hot paths that already know the meta cache
 * is populated (the WS layer warms it at boot via ensureValidCoins).
 * Returns null if the cache is empty or the symbol is unknown.
 */
export function resolveHlCoinSync(symbol: string): string | null {
  const fromRegistry = symbolRegistry.toNative(symbol, "hl");
  const fromLegacy = upperToOrigCoin.get(toHlCoinUpper(symbol)) ?? null;
  if (fromRegistry && fromLegacy && fromRegistry !== fromLegacy) {
    logDisagreement("resolveHlCoinSync", symbol, fromRegistry, fromLegacy);
  }
  return fromRegistry ?? fromLegacy;
}

export interface HlAssetCtx {
  coin: string;
  funding: number;
  openInterest: number;
  markPx: number;
  oraclePx: number;
  midPx: number;
  prevDayPx: number;
  dayNtlVlm: number;
}

interface RawMeta {
  universe: { name: string; szDecimals: number }[];
}
interface RawCtx {
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  midPx: string;
  prevDayPx: string;
  dayNtlVlm: string;
}

let metaCache: { data: Map<string, HlAssetCtx>; expiresAt: number } | null =
  null;

export async function fetchAllAssets(): Promise<Map<string, HlAssetCtx> | null> {
  if (metaCache && Date.now() < metaCache.expiresAt) return metaCache.data;

  const raw = await postJson<[RawMeta, RawCtx[]]>({
    type: "metaAndAssetCtxs",
  });
  if (!raw?.[0]?.universe || !raw?.[1]) return null;

  const map = new Map<string, HlAssetCtx>();
  const nextUpperToOrig = new Map<string, string>();
  const universe = raw[0].universe;
  const ctxs = raw[1];

  for (let i = 0; i < universe.length && i < ctxs.length; i++) {
    const name = universe[i].name;
    const c = ctxs[i];
    map.set(name, {
      coin: name,
      funding: parseFloat(c.funding),
      openInterest: parseFloat(c.openInterest),
      markPx: parseFloat(c.markPx),
      oraclePx: parseFloat(c.oraclePx),
      midPx: parseFloat(c.midPx) || parseFloat(c.markPx),
      prevDayPx: parseFloat(c.prevDayPx),
      dayNtlVlm: parseFloat(c.dayNtlVlm),
    });
    nextUpperToOrig.set(name.toUpperCase(), name);
  }

  upperToOrigCoin = nextUpperToOrig;
  metaCache = { data: map, expiresAt: Date.now() + META_TTL };
  return map;
}

export async function fetchAsset(
  symbol: string
): Promise<HlAssetCtx | null> {
  const all = await fetchAllAssets();
  const coin = upperToOrigCoin.get(toHlCoinUpper(symbol));
  if (!coin) return null;
  return all?.get(coin) ?? null;
}

export interface HlBookLevel {
  price: number;
  size: number;
  numOrders: number;
}

export interface HlOrderbook {
  bids: HlBookLevel[];
  asks: HlBookLevel[];
}

export async function fetchOrderbook(
  symbol: string
): Promise<HlOrderbook | null> {
  const coin = await resolveHlCoin(symbol);
  if (!coin) return null;
  const key = `hl:book:${coin}`;
  const cached = getCached<HlOrderbook>(key);
  if (cached) return cached;

  const raw = await postJson<{
    levels: { px: string; sz: string; n: number }[][];
  }>({ type: "l2Book", coin });
  if (!raw?.levels?.[0] || !raw?.levels?.[1]) return null;

  const parseLevel = (l: {
    px: string;
    sz: string;
    n: number;
  }): HlBookLevel => ({
    price: parseFloat(l.px),
    size: parseFloat(l.sz),
    numOrders: l.n,
  });

  const book: HlOrderbook = {
    bids: raw.levels[0].map(parseLevel),
    asks: raw.levels[1].map(parseLevel),
  };
  setCache(key, book, BOOK_TTL);
  return book;
}
