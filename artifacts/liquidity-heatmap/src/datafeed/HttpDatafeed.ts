// Phase 3 — Production IDatafeed implementation.
//
// Talks to the api-server's HTTP routes (`/api/symbol/*`,
// `/api/liquidity/candles`, `/api/levels`, `/api/liquidity/liquidations`,
// `/api/liquidity/server-time`) and the `/ws` hub channels (`heatmap:*`,
// `depth:*`, `levels:*`). All transport — no engine math, no scoring,
// no level generation, no registry mutation.

import { apiUrl } from "@/lib/api";
import {
  IDatafeed,
  SymbolInfo,
  CandlesRequest,
  CandlesResponse,
  Bar,
  BarsSubRequest,
  MarkTick,
  LevelItem,
  LevelsRequest,
  LevelsResponse,
  LevelsDelta,
  DepthSnapshot,
  LiqCluster,
  LiqClustersSnapshot,
  Subscription,
  Resolution,
  INTERVAL_MS,
} from "./types";
import { rollover } from "./localRollover";
import { getDatafeedWsClient } from "./wsClient";
import { normalizeSymbolKey, normalizeIntervalKey } from "./normalize";

// ── Resolution → backend interval string ──────────────────────────────
//
// The backend's `/api/liquidity/candles` accepts the same uppercase
// `H/D/W/M` and lowercase `m` suffixes our Resolution type already uses,
// so this is the identity. Kept as a function so a future TV adapter
// can map "60" → "1H" through this same datafeed without changing the
// contract.
function resolutionToInterval(res: Resolution): string {
  return normalizeIntervalKey(res);
}


interface CandleApiBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleApiResponse {
  symbol: string;
  interval: string;
  candles: CandleApiBar[];
  source: string | null;
}

interface SymbolApiItem {
  ui: string;
  base: string;
  quote?: string;
  // Backend returns the registry's `listed` map (per-exchange yes/no),
  // not a flat exchanges array. We derive the array client-side in
  // toSymbolInfo so the IDatafeed contract stays clean.
  listed?: Record<string, string>;
  // Tolerated for forward compat: if a future backend revision ships a
  // pre-flattened array, we honor it.
  exchanges?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<{ res: Response; json: T }> {
  const res = await fetch(url, { credentials: "include", ...init });
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    json = {} as T;
  }
  return { res, json };
}

function finitePositive(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Maps the registry's exchange short-codes to the contract's stable
// names. The registry uses `hl` for Hyperliquid; the rest of the
// codebase (and the heatmap engine output) uses `hyperliquid`. Any
// other code is passed through verbatim.
function canonicalExchangeName(code: string): string {
  if (code === "hl") return "hyperliquid";
  return code;
}

// Reverse mapping for outbound calls: callers pass the canonical
// contract name (e.g. `hyperliquid`) but the backend's `/api/symbol/list`
// `?exchange=` filter expects the registry short-code (`hl`). Anything
// else is forwarded verbatim so a caller can still pass a raw registry
// code if they already have one.
export function backendExchangeCode(name: string): string {
  if (name === "hyperliquid") return "hl";
  return name;
}

export function exchangesFromListed(
  listed: Record<string, string> | undefined,
): string[] {
  if (!listed || typeof listed !== "object") return [];
  const out: string[] = [];
  for (const [code, status] of Object.entries(listed)) {
    if (typeof status === "string" && status.toLowerCase() === "yes") {
      out.push(canonicalExchangeName(code));
    }
  }
  // Stable order so identity comparisons / snapshot tests don't flap.
  out.sort();
  return out;
}

function toSymbolInfo(row: SymbolApiItem): SymbolInfo {
  const ui = typeof row.ui === "string" && row.ui.trim() ? row.ui.trim().toUpperCase() : "UNKNOWNUSDT";
  const base = typeof row.base === "string" && row.base.trim()
    ? row.base.trim().toUpperCase()
    : ui.replace(/USDT$/, "");
  const quote = typeof row.quote === "string" && row.quote.trim() ? row.quote.trim().toUpperCase() : "USDT";
  // Prefer a pre-flattened `exchanges` array if a future backend ships
  // one; otherwise derive from `listed`. Empty array means "registry
  // didn't list this symbol on any tracked venue", which is honest.
  const exchanges = Array.isArray(row.exchanges) && row.exchanges.length > 0
    ? row.exchanges
    : exchangesFromListed(row.listed);
  return {
    ui,
    base,
    quote,
    exchanges,
    // Description is derived locally so callers (e.g. a TV searchSymbols
    // hook) get a human label without the backend having to ship it.
    // T1's backend left the `description` field unmodelled by design;
    // we synthesize a stable one here so the contract has it from day
    // one. Format: "BASE / QUOTE".
    description: `${base} / ${quote}`,
  };
}

function toBar(c: CandleApiBar): Bar | null {
  const time = Number(c.timestamp);
  const open = finitePositive(c.open);
  const high = finitePositive(c.high);
  const low = finitePositive(c.low);
  const close = finitePositive(c.close);
  const volume = Number(c.volume);
  if (!Number.isFinite(time) || time <= 0 || open === null || high === null || low === null || close === null) {
    return null;
  }
  const hi = Math.max(high, open, close, low);
  const lo = Math.min(low, open, close, high);
  return {
    time,
    open,
    high: hi,
    low: lo,
    close,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
  };
}

// Best-effort mapper for the heterogenous level rows returned by
// `/api/levels`. The route blends multiple sources (KDE pivot, market
// profile, registry) into a single array; common fields are present on
// every row, the rest are forwarded via `raw`.
function toLevelItem(row: Record<string, unknown>): LevelItem | null {
  const price = typeof row.price === "number" ? row.price : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;
  const kindRaw = typeof row.kind === "string" ? row.kind : (row.side as string);
  const side: LevelItem["side"] =
    kindRaw === "support" || kindRaw === "resistance" || kindRaw === "neutral"
      ? kindRaw
      : "neutral";
  const strength = typeof row.strength === "number" ? row.strength : 0;
  const out: LevelItem = { price, side, strength, raw: row };
  if (typeof row.tier === "number") out.tier = row.tier;
  if (typeof row.method === "string") out.method = row.method;
  if (Array.isArray(row.methods)) out.methods = row.methods as string[];
  if (typeof row.reliability === "number") out.reliability = row.reliability;
  if (typeof row.touches === "number") out.touches = row.touches;
  if (typeof row.validated === "boolean") out.validated = row.validated;
  return out;
}

class HttpDatafeed implements IDatafeed {
  // ── Symbols ─────────────────────────────────────────────────────────
  async listSymbols(opts: {
    exchange?: string;
    limit?: number;
  } = {}): Promise<{ items: SymbolInfo[]; total: number }> {
    const params = new URLSearchParams();
    if (opts.exchange) params.set("exchange", backendExchangeCode(opts.exchange));
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = apiUrl(`/api/symbol/list${qs ? `?${qs}` : ""}`);
    const { res, json } = await fetchJson<{ items?: SymbolApiItem[]; total?: number }>(url);
    if (!res.ok) throw new Error(`symbol/list ${res.status}`);
    return {
      items: (Array.isArray(json.items) ? json.items : []).map(toSymbolInfo),
      total: typeof json.total === "number" ? json.total : (Array.isArray(json.items) ? json.items.length : 0),
    };
  }

  async getSymbol(ui: string): Promise<SymbolInfo | null> {
    // The backend's primary search-by-symbol path is `/symbol/search?q=`
    // with exact-first ordering; we reuse it instead of adding a new
    // route. The first row whose `ui` matches the normalized input is
    // the canonical hit.
    const norm = normalizeSymbolKey(ui);
    const items = await this.searchSymbols(norm, { limit: 5 });
    return items.find((s) => s.ui === norm) ?? null;
  }

  async searchSymbols(
    q: string,
    opts: { limit?: number } = {},
  ): Promise<SymbolInfo[]> {
    const params = new URLSearchParams({ q });
    if (opts.limit) params.set("limit", String(opts.limit));
    const url = apiUrl(`/api/symbol/search?${params.toString()}`);
    const { res, json } = await fetchJson<{ items?: SymbolApiItem[] }>(url);
    if (!res.ok) throw new Error(`symbol/search ${res.status}`);
    return (Array.isArray(json.items) ? json.items : []).map(toSymbolInfo);
  }

  // ── Candles ─────────────────────────────────────────────────────────
  async fetchCandles(req: CandlesRequest): Promise<CandlesResponse> {
    const sym = normalizeSymbolKey(req.symbol);
    const interval = resolutionToInterval(req.resolution);
    const params = new URLSearchParams({ symbol: sym, interval });
    const isRange =
      typeof req.from === "number" &&
      typeof req.to === "number" &&
      req.from < req.to;
    if (isRange) {
      params.set("from", String(req.from));
      params.set("to", String(req.to));
    } else {
      params.set("limit", String(req.limit ?? 300));
    }
    const url = apiUrl(`/api/liquidity/candles?${params.toString()}`);
    const { res, json } = await fetchJson<Partial<CandleApiResponse>>(url);
    if (!res.ok) throw new Error(`candles ${res.status}`);
    const headerMode = res.headers.get("X-Candles-Mode");
    const bars: Bar[] = (Array.isArray(json.candles) ? json.candles : [])
      .map(toBar)
      .filter((bar): bar is Bar => bar !== null);
    // Trust the response header when it's present; otherwise infer from
    // the request shape. The header is set by the new range branch and
    // by future range routes; legacy responses won't have it.
    const mode: CandlesResponse["mode"] =
      headerMode === "range" ? "range" : isRange ? "range" : "limit";
    return { bars, source: typeof json.source === "string" ? json.source : null, mode };
  }

  subscribeBars(
    req: BarsSubRequest,
    onBar: (bar: Bar) => void,
  ): Subscription {
    const sym = normalizeSymbolKey(req.symbol);
    const channel = `heatmap:${sym}`;
    let active: Bar | null = req.lastBar ? { ...req.lastBar } : null;

    const unsub = getDatafeedWsClient().subscribe(channel, (data) => {
      const mark = extractMarkPrice(data);
      if (mark === null) return;
      const result = rollover(req.resolution, active, mark, Date.now());
      if (!result) return;
      active = result.bar;
      onBar({ ...active });
    });

    return { unsubscribe: unsub };
  }

  // ── Mark price ──────────────────────────────────────────────────────
  subscribeMark(
    symbol: string,
    onTick: (tick: MarkTick) => void,
  ): Subscription {
    const sym = normalizeSymbolKey(symbol);
    const channel = `heatmap:${sym}`;
    const unsub = getDatafeedWsClient().subscribe(channel, (data) => {
      const mark = extractMarkPrice(data);
      if (mark === null) return;
      onTick({ symbol: sym, markPrice: mark, ts: Date.now() });
    });
    return { unsubscribe: unsub };
  }

  // ── Levels ──────────────────────────────────────────────────────────
  async fetchLevels(req: LevelsRequest): Promise<LevelsResponse> {
    const sym = normalizeSymbolKey(req.symbol);
    const params = new URLSearchParams({ symbol: sym, interval: normalizeIntervalKey(req.interval) });
    const url = apiUrl(`/api/levels?${params.toString()}`);
    const { res, json } = await fetchJson<{
      symbol?: string;
      interval?: string;
      levels?: Array<Record<string, unknown>>;
      updatedAt?: string;
    }>(url);
    if (!res.ok) throw new Error(`levels ${res.status}`);
    const items: LevelItem[] = [];
    for (const row of Array.isArray(json.levels) ? json.levels : []) {
      const item = toLevelItem(row);
      if (item) items.push(item);
    }
    return {
      symbol: json.symbol ?? sym,
      interval: normalizeIntervalKey(json.interval ?? req.interval),
      levels: items,
      updatedAt: json.updatedAt ?? new Date().toISOString(),
      raw: json,
    };
  }

  subscribeLevels(
    symbol: string,
    onDelta: (delta: LevelsDelta) => void,
  ): Subscription {
    const sym = normalizeSymbolKey(symbol);
    const channel = `levels:${sym}`;
    const unsub = getDatafeedWsClient().subscribe(channel, (data) => {
      const payload = data as {
        symbol?: string;
        levels?: Array<Record<string, unknown>>;
        updatedAt?: string;
      } | null;
      if (!payload || !Array.isArray(payload.levels)) return;
      const items: LevelItem[] = [];
      for (const row of payload.levels) {
        const item = toLevelItem(row);
        if (item) items.push(item);
      }
      onDelta({
        symbol: payload.symbol ?? sym,
        levels: items,
        updatedAt: payload.updatedAt ?? new Date().toISOString(),
      });
    });
    return { unsubscribe: unsub };
  }

  // ── Depth ───────────────────────────────────────────────────────────
  subscribeDepth(
    symbol: string,
    onSnap: (snap: DepthSnapshot) => void,
  ): Subscription {
    const sym = normalizeSymbolKey(symbol);
    const channel = `depth:${sym}`;
    const unsub = getDatafeedWsClient().subscribe(channel, (data) => {
      const payload = data as Partial<DepthSnapshot> | null;
      if (!payload || !Array.isArray(payload.bids) || !Array.isArray(payload.asks)) {
        return;
      }
      onSnap({
        symbol: payload.symbol ?? sym,
        exchange: payload.exchange ?? "unknown",
        bids: payload.bids,
        asks: payload.asks,
        updatedAt: payload.updatedAt ?? new Date().toISOString(),
      });
    });
    return { unsubscribe: unsub };
  }

  // ── Liquidations ────────────────────────────────────────────────────
  //
  // Polls `/api/liquidity/liquidations/clusters` (the same route the
  // existing chart's liquidations sidebar consumes) on a fixed interval
  // and emits a normalized `LiqClustersSnapshot` per tick. The contract
  // intentionally hands back the whole window snapshot rather than a
  // diff: the route is already aggregated server-side and replacing the
  // full set is what every consumer wants today.
  subscribeLiquidations(
    symbol: string,
    onSnapshot: (snap: LiqClustersSnapshot) => void,
    opts: { intervalMs?: number; windowMs?: number; bucketBps?: number } = {},
  ): Subscription {
    const sym = normalizeSymbolKey(symbol);
    const intervalMs = Math.max(2_000, opts.intervalMs ?? 5_000);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: AbortController | null = null;

    const params = new URLSearchParams({ symbol: sym });
    if (typeof opts.windowMs === "number" && opts.windowMs > 0) {
      params.set("windowMs", String(Math.floor(opts.windowMs)));
    }
    if (typeof opts.bucketBps === "number" && opts.bucketBps > 0) {
      params.set("bucketBps", String(Math.floor(opts.bucketBps)));
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      inflight?.abort();
      const ac = new AbortController();
      inflight = ac;
      try {
        const url = apiUrl(`/api/liquidity/liquidations/clusters?${params.toString()}`);
        const { res, json } = await fetchJson<Record<string, unknown>>(url, { signal: ac.signal });
        if (!res.ok) throw new Error(`liquidations/clusters ${res.status}`);
        const snap = parseClustersResponse(json, sym);
        if (snap && !cancelled) onSnapshot(snap);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        // Silent: cluster route can return 503 or an empty window when
        // feeds are quiet; the caller's last good snapshot stays.
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    void tick();
    return {
      unsubscribe(): void {
        cancelled = true;
        if (timer) clearTimeout(timer);
        inflight?.abort();
      },
    };
  }

  // ── Server time ─────────────────────────────────────────────────────
  async serverTime(): Promise<number> {
    const url = apiUrl(`/api/liquidity/server-time`);
    const { res, json } = await fetchJson<{ now?: number }>(url);
    if (!res.ok) throw new Error(`server-time ${res.status}`);
    const now = Number(json.now);
    return Number.isFinite(now) && now > 0 ? now : Date.now();
  }
}

// ── Liquidations cluster parser ────────────────────────────────────────
//
// `/api/liquidity/liquidations/clusters` returns:
//   { windowMs, bucketBps, symbols, source, updatedAt,
//     clusters: [{ symbol, bucketPrice, bucketLow, bucketHigh,
//                  longUsd, shortUsd, totalUsd, count, sources, lastTs,
//                  lastTimestamp }, ...] }
//
// We normalize into a `LiqClustersSnapshot`. Drops malformed rows
// silently (rather than failing the whole snapshot) so a single bad
// bucket from upstream doesn't blank the chart's sidebar.
export function parseClustersResponse(
  body: Record<string, unknown>,
  defaultSymbol: string,
): LiqClustersSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const rawClusters = Array.isArray(body.clusters) ? body.clusters : [];
  const clusters: LiqCluster[] = [];
  for (const c of rawClusters) {
    const cluster = parseLiqCluster(c as Record<string, unknown>, defaultSymbol);
    if (cluster) clusters.push(cluster);
  }
  const windowMs = Number(body.windowMs);
  const bucketBps = Number(body.bucketBps);
  return {
    symbol: defaultSymbol,
    windowMs: Number.isFinite(windowMs) ? windowMs : 0,
    bucketBps: Number.isFinite(bucketBps) ? bucketBps : 0,
    clusters,
    source: typeof body.source === "string" ? body.source : null,
    updatedAt: typeof body.updatedAt === "string"
      ? body.updatedAt
      : new Date().toISOString(),
  };
}

export function parseLiqCluster(
  row: Record<string, unknown>,
  defaultSymbol: string,
): LiqCluster | null {
  if (!row || typeof row !== "object") return null;
  const bucketPrice = Number(row.bucketPrice);
  if (!Number.isFinite(bucketPrice) || bucketPrice <= 0) return null;

  const bucketLow = Number(row.bucketLow);
  const bucketHigh = Number(row.bucketHigh);
  const longUsd = Number(row.longUsd);
  const shortUsd = Number(row.shortUsd);
  const totalUsdNum = Number(row.totalUsd);
  const totalUsd = Number.isFinite(totalUsdNum)
    ? totalUsdNum
    : (Number.isFinite(longUsd) ? longUsd : 0)
      + (Number.isFinite(shortUsd) ? shortUsd : 0);
  const count = Number(row.count);

  // lastTs: prefer numeric `lastTs`, fall back to ISO `lastTimestamp`.
  let lastTs = NaN;
  if (typeof row.lastTs === "number" && Number.isFinite(row.lastTs)) {
    lastTs = row.lastTs;
  } else if (typeof row.lastTimestamp === "string") {
    const parsed = Date.parse(row.lastTimestamp);
    if (Number.isFinite(parsed)) lastTs = parsed;
  }
  if (!Number.isFinite(lastTs)) lastTs = 0;

  const sources: Record<string, number> = {};
  const rawSources = row.sources;
  if (rawSources && typeof rawSources === "object") {
    for (const [k, v] of Object.entries(rawSources)) {
      const n = Number(v);
      if (Number.isFinite(n)) sources[k] = n;
    }
  }

  return {
    symbol: typeof row.symbol === "string" ? row.symbol : defaultSymbol,
    bucketPrice,
    bucketLow: Number.isFinite(bucketLow) ? bucketLow : bucketPrice,
    bucketHigh: Number.isFinite(bucketHigh) ? bucketHigh : bucketPrice,
    longUsd: Number.isFinite(longUsd) ? longUsd : 0,
    shortUsd: Number.isFinite(shortUsd) ? shortUsd : 0,
    totalUsd,
    count: Number.isFinite(count) ? count : 0,
    sources,
    lastTs,
  };
}

// ── Helpers shared by mark & bar subscriptions ─────────────────────────

function extractMarkPrice(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const m = (data as { markPrice?: number }).markPrice;
  if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  return null;
}

let singleton: HttpDatafeed | null = null;

export function getHttpDatafeed(): HttpDatafeed {
  if (!singleton) singleton = new HttpDatafeed();
  return singleton;
}

// Test-only.
export function __resetHttpDatafeed(): void {
  singleton = null;
}
