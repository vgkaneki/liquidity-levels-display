import { getCached, setCache } from "./cache";

const BASE = "https://www.okx.com/api/v5";
const TICKER_TTL = 5000;
const BOOK_TTL = 3000;
const CANDLE_TTL = 15000;
const INSTRUMENTS_TTL = 300000;
const FUNDING_TTL = 30000;
const OI_TTL = 10000;

function toOkxInstId(symbol: string): string {
  const clean = symbol.replace(/-/g, "").toUpperCase();
  const base = clean.replace(/USDT$/, "");
  return `${base}-USDT-SWAP`;
}

function fromOkxInstId(instId: string): string {
  return instId.replace("-SWAP", "").replace(/-/g, "");
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { code?: string; data?: T };
    if (json.code !== "0" || !json.data) return null;
    return json.data as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface OkxTicker {
  instId: string;
  last: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  vol24h: string;
  ts: string;
}

export async function fetchTicker(
  symbol: string
): Promise<OkxTicker | null> {
  const instId = toOkxInstId(symbol);
  const key = `okx:ticker:${instId}`;
  const cached = getCached<OkxTicker>(key);
  if (cached) return cached;

  const data = await fetchJson<OkxTicker[]>(
    `${BASE}/market/ticker?instId=${instId}`
  );
  if (!data?.[0]) return null;
  setCache(key, data[0], TICKER_TTL);
  return data[0];
}

export interface OkxBookLevel {
  price: number;
  size: number;
  numOrders: number;
}

export interface OkxOrderbook {
  bids: OkxBookLevel[];
  asks: OkxBookLevel[];
}

export async function fetchOrderbook(
  symbol: string,
  depth: number = 100
): Promise<OkxOrderbook | null> {
  const instId = toOkxInstId(symbol);
  const sz = Math.min(400, Math.max(20, depth));
  const key = `okx:book:${instId}:${sz}`;
  const cached = getCached<OkxOrderbook>(key);
  if (cached) return cached;

  const data = await fetchJson<
    { bids: string[][]; asks: string[][] }[]
  >(`${BASE}/market/books?instId=${instId}&sz=${sz}`);
  if (!data?.[0]) return null;

  const parseLevel = (arr: string[]): OkxBookLevel => ({
    price: parseFloat(arr[0]),
    size: parseFloat(arr[1]),
    numOrders: parseInt(arr[3], 10) || 1,
  });

  const book: OkxOrderbook = {
    bids: data[0].bids.map(parseLevel),
    asks: data[0].asks.map(parseLevel),
  };
  setCache(key, book, BOOK_TTL);
  return book;
}

export interface OkxCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirmed: boolean;
}

const VALID_BARS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1H", "2H", "4H", "6H", "12H",
  "1D", "3D", "1W", "1M",
]);

function parseCandleRow(c: string[]): OkxCandle {
  return {
    timestamp: parseInt(c[0], 10),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
    confirmed: c[8] === "1",
  };
}

export async function fetchCandles(
  symbol: string,
  limit: number = 200,
  bar: string = "4H"
): Promise<OkxCandle[] | null> {
  const safebar = VALID_BARS.has(bar) ? bar : "4H";
  const instId = toOkxInstId(symbol);
  const key = `okx:candles:${instId}:${safebar}:${limit}`;
  const cached = getCached<OkxCandle[]>(key);
  if (cached) return cached;

  // OKX caps each request at 300. For larger requests we first fetch the
  // most recent 300 from /market/candles, then page backwards through
  // /market/history-candles (max 100/page) until we have `limit` bars.
  const recentSize = Math.min(300, limit);
  const recent = await fetchJson<string[][]>(
    `${BASE}/market/candles?instId=${instId}&bar=${safebar}&limit=${recentSize}`
  );
  if (!recent?.length) return null;

  const allRows: string[][] = [...recent];
  let oldestTs = parseInt(recent[recent.length - 1][0], 10);

  while (allRows.length < limit) {
    const remaining = limit - allRows.length;
    const pageSize = Math.min(100, remaining);
    const page = await fetchJson<string[][]>(
      `${BASE}/market/history-candles?instId=${instId}&bar=${safebar}&limit=${pageSize}&after=${oldestTs}`
    );
    if (!page?.length) break;
    allRows.push(...page);
    const newOldest = parseInt(page[page.length - 1][0], 10);
    if (!Number.isFinite(newOldest) || newOldest >= oldestTs) break;
    oldestTs = newOldest;
  }

  const candles: OkxCandle[] = allRows.map(parseCandleRow).reverse();

  setCache(key, candles, CANDLE_TTL);
  return candles;
}

export interface OkxFunding {
  fundingRate: number;
  nextFundingRate: number | null;
}

export async function fetchFunding(
  symbol: string
): Promise<OkxFunding | null> {
  const instId = toOkxInstId(symbol);
  const key = `okx:funding:${instId}`;
  const cached = getCached<OkxFunding>(key);
  if (cached) return cached;

  const data = await fetchJson<
    { fundingRate: string; nextFundingRate: string }[]
  >(`${BASE}/public/funding-rate?instId=${instId}`);
  if (!data?.[0]) return null;

  const result: OkxFunding = {
    fundingRate: parseFloat(data[0].fundingRate),
    nextFundingRate: data[0].nextFundingRate
      ? parseFloat(data[0].nextFundingRate)
      : null,
  };
  setCache(key, result, FUNDING_TTL);
  return result;
}

export interface OkxOpenInterest {
  oi: number;
  oiUsd: number;
}

export async function fetchOpenInterest(
  symbol: string
): Promise<OkxOpenInterest | null> {
  const instId = toOkxInstId(symbol);
  const key = `okx:oi:${instId}`;
  const cached = getCached<OkxOpenInterest>(key);
  if (cached) return cached;

  const data = await fetchJson<{ oi: string; oiUsd: string }[]>(
    `${BASE}/public/open-interest?instType=SWAP&instId=${instId}`
  );
  if (!data?.[0]) return null;

  const result: OkxOpenInterest = {
    oi: parseFloat(data[0].oi),
    oiUsd: parseFloat(data[0].oiUsd),
  };
  setCache(key, result, OI_TTL);
  return result;
}

export interface OkxInstrument {
  instId: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export async function fetchInstruments(): Promise<OkxInstrument[] | null> {
  const key = "okx:instruments";
  const cached = getCached<OkxInstrument[]>(key);
  if (cached) return cached;

  const data = await fetchJson<
    { instId: string; settleCcy: string; ctValCcy: string }[]
  >(`${BASE}/public/instruments?instType=SWAP`);
  if (!data?.length) return null;

  const instruments: OkxInstrument[] = data
    .filter((i) => i.settleCcy === "USDT")
    .map((i) => {
      const sym = fromOkxInstId(i.instId);
      const base = i.ctValCcy || sym.replace(/USDT$/, "");
      return {
        instId: i.instId,
        symbol: sym,
        baseAsset: base,
        quoteAsset: "USDT",
      };
    });

  setCache(key, instruments, INSTRUMENTS_TTL);
  return instruments;
}
