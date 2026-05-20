// Toobit USDT-margined perpetuals — REST client (Phase B, read-only).
//
// Used for: symbol-universe bootstrap, depth snapshots, and kline backfill.
// All live tick data flows over WebSocket (see toobit-ws.ts). This module
// is intentionally isolated from okx.ts / hyperliquid.ts and never writes
// into the OKX/HL stores.

const REST_BASE = "https://api.toobit.com";
const FETCH_TIMEOUT_MS = 8_000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${REST_BASE}${path}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface ToobitInstrument {
  symbol: string;        // e.g. BTC-SWAP-USDT  (Toobit native)
  uiSymbol: string;      // e.g. BTCUSDT        (normalized for our app)
  baseAsset: string;
  quoteAsset: "USDT";
  contractMultiplier: number;
}

interface ExchangeInfoSymbol {
  symbol?: string;
  baseAsset?: string;
  baseAssetName?: string;
  quoteAsset?: string;
  quoteAssetName?: string;
  contractMultiplier?: string | number;
  status?: string;
  inverse?: boolean;
  // Toobit-specific: `baseAsset` is the FULL symbol string ("BTC-SWAP-USDT"),
  // not the actual base. The real base lives in `index`/`underlying`, and a
  // ready-made canonical pair string lives in `indexToken`.
  index?: string;
  underlying?: string;
  indexToken?: string;
}
interface ExchangeInfoResponse {
  symbols?: ExchangeInfoSymbol[];
  contracts?: ExchangeInfoSymbol[];
}

function realBaseFromToobit(s: ExchangeInfoSymbol): string {
  // Prefer Toobit's authoritative fields (`index` / `underlying`). Fall back
  // to stripping the swap suffix off the misnamed `baseAsset` field, then
  // finally to the symbol string itself.
  const candidates = [
    s.index,
    s.underlying,
    (s.baseAsset || s.baseAssetName || "").replace(/-SWAP-USDT?C?$/i, ""),
    (s.symbol || "").replace(/-SWAP-USDT?C?$/i, ""),
  ];
  for (const c of candidates) {
    const v = (c || "").toUpperCase().trim();
    if (v && !v.includes("-")) return v;
  }
  return "";
}

function uiSymbolFromToobit(s: ExchangeInfoSymbol): string {
  // `indexToken` is Toobit's canonical pair string (e.g. "BTCUSDT") — use it
  // when present, otherwise derive from the real base.
  const idx = (s.indexToken || "").toUpperCase().trim();
  if (idx && /^[A-Z0-9]+USDT$/.test(idx)) return idx;
  const base = realBaseFromToobit(s);
  return base ? `${base}USDT` : "";
}

/**
 * Fetch the Toobit perp universe and filter to USDT-margined contracts only.
 * Phase B explicitly excludes coin-margined / inverse contracts.
 */
export async function fetchInstruments(): Promise<ToobitInstrument[] | null> {
  const data = await fetchJson<ExchangeInfoResponse>("/api/v1/exchangeInfo");
  if (!data) return null;
  const list = data.contracts ?? data.symbols ?? [];
  if (!Array.isArray(list) || list.length === 0) return null;

  const out: ToobitInstrument[] = [];
  for (const s of list) {
    const quote = (s.quoteAsset || s.quoteAssetName || "").toUpperCase();
    if (quote !== "USDT") continue;
    if (s.inverse === true) continue;
    if (s.contractMultiplier === undefined || s.contractMultiplier === null) continue;
    const mult = typeof s.contractMultiplier === "string"
      ? parseFloat(s.contractMultiplier)
      : s.contractMultiplier;
    if (!Number.isFinite(mult) || mult <= 0) continue;
    if (s.status && String(s.status).toUpperCase() !== "TRADING") continue;
    const native = (s.symbol || "").toUpperCase();
    if (!native) continue;
    const ui = uiSymbolFromToobit(s);
    if (!ui) continue;
    const base = realBaseFromToobit(s);
    if (!base) continue;
    out.push({
      symbol: native,
      uiSymbol: ui,
      baseAsset: base,
      quoteAsset: "USDT",
      contractMultiplier: mult,
    });
  }
  return out.length > 0 ? out : null;
}

export interface ToobitDepthSnapshot {
  bids: [number, number][];
  asks: [number, number][];
}

export async function fetchDepthSnapshot(
  toobitSymbol: string,
  limit = 100,
): Promise<ToobitDepthSnapshot | null> {
  const sz = Math.min(200, Math.max(5, Math.floor(limit)));
  const data = await fetchJson<{ b?: string[][]; a?: string[][]; bids?: string[][]; asks?: string[][] }>(
    `/quote/v1/depth?symbol=${encodeURIComponent(toobitSymbol)}&limit=${sz}`,
  );
  if (!data) return null;
  const rawBids = data.b ?? data.bids ?? [];
  const rawAsks = data.a ?? data.asks ?? [];
  const parse = (rows: string[][]): [number, number][] =>
    rows
      .map((r) => [parseFloat(r[0]), parseFloat(r[1])] as [number, number])
      .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]));
  return { bids: parse(rawBids), asks: parse(rawAsks) };
}

export interface ToobitKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const VALID_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "12h",
  "1d", "3d", "1w", "1M",
]);

export async function fetchKlines(
  toobitSymbol: string,
  interval = "1h",
  limit = 200,
): Promise<ToobitKline[] | null> {
  const safe = VALID_INTERVALS.has(interval) ? interval : "1h";
  const sz = Math.min(1000, Math.max(1, Math.floor(limit)));
  const data = await fetchJson<unknown[]>(
    `/quote/v1/klines?symbol=${encodeURIComponent(toobitSymbol)}&interval=${safe}&limit=${sz}`,
  );
  if (!Array.isArray(data) || data.length === 0) return null;

  const out: ToobitKline[] = [];
  for (const row of data) {
    // Toobit returns either [t, o, h, l, c, v, ...] arrays or
    // {t,o,h,l,c,v} objects depending on endpoint version.
    if (Array.isArray(row)) {
      const [t, o, h, l, c, v] = row as (string | number)[];
      out.push({
        timestamp: typeof t === "number" ? t : parseInt(String(t), 10),
        open: parseFloat(String(o)),
        high: parseFloat(String(h)),
        low: parseFloat(String(l)),
        close: parseFloat(String(c)),
        volume: parseFloat(String(v)),
      });
    } else if (row && typeof row === "object") {
      const r = row as Record<string, string | number>;
      out.push({
        timestamp: typeof r.t === "number" ? r.t : parseInt(String(r.t), 10),
        open: parseFloat(String(r.o)),
        high: parseFloat(String(r.h)),
        low: parseFloat(String(r.l)),
        close: parseFloat(String(r.c)),
        volume: parseFloat(String(r.v)),
      });
    }
  }
  return out.filter((k) => Number.isFinite(k.timestamp) && Number.isFinite(k.close));
}
