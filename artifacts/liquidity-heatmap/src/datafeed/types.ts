// Phase 3 — IDatafeed contract.
//
// This file defines the stable, transport-agnostic surface that the chart,
// the `/spike` route, the future TradingView adapter, and any new chart-
// side feature binds to. The whole point of the layer is that swapping
// the implementation (HTTP+WS today, vendored TradingView library later,
// a mock for tests) requires zero changes outside `src/datafeed/`.
//
// ENGINE GUARDRAIL: nothing in this layer performs scoring, confluence,
// reliability, regime, level-generation, touch confirmation, or registry
// math. It is a transport contract only — it shapes data the engines and
// backend already produce.

export type Resolution =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1H" | "2H" | "4H" | "6H" | "12H"
  | "1D" | "3D" | "1W" | "1M";

export const INTERVAL_MS: Record<Resolution, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1H": 3_600_000,
  "2H": 7_200_000,
  "4H": 14_400_000,
  "6H": 21_600_000,
  "12H": 43_200_000,
  "1D": 86_400_000,
  "3D": 259_200_000,
  "1W": 604_800_000,
  "1M": 2_592_000_000,
};

export interface SymbolInfo {
  ui: string;        // canonical UI ticker, e.g. "BTCUSDT"
  base: string;      // base asset, e.g. "BTC"
  quote: string;     // quote asset, e.g. "USDT"
  exchanges: string[]; // exchanges listing this symbol (subset of "okx"|"hl"|"toobit")
  description?: string; // optional human label (e.g. "Bitcoin / Tether"); may be derived
}

export interface Bar {
  // Epoch milliseconds at the start of the bar's interval window. Renderer
  // wrappers convert to seconds for libraries that want it (TV, lightweight-
  // charts). Keeping the contract in ms matches what every backend route
  // already returns.
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlesRequest {
  symbol: string;
  resolution: Resolution;
  // Range mode: when both `from` and `to` are set, the datafeed asks the
  // backend's range-aware endpoint and the response carries `mode:"range"`.
  // Otherwise it falls back to the legacy `limit` mode.
  from?: number; // epoch ms (inclusive)
  to?: number;   // epoch ms (exclusive)
  limit?: number; // bars (1..500); ignored in range mode
}

export interface CandlesResponse {
  bars: Bar[];
  source: string | null;          // upstream feed reported by the API
  mode: "range" | "limit";        // which path served the response
}

export interface BarsSubRequest {
  symbol: string;
  resolution: Resolution;
  // Last bar the renderer already shows; used to seed the rollover state
  // so a tick that lands in the same window extends, not replaces.
  lastBar: Bar | null;
}

export interface MarkTick {
  symbol: string;
  markPrice: number;
  ts: number; // epoch ms
}

export interface LevelItem {
  // The chart cares about price + side + strength. Everything else is
  // optional and forwarded through for callers that want to render
  // tier or method badges. We deliberately model this loose enough to
  // accept either today's REST `/api/levels` rows or a future registry-
  // direct row, so consumers don't need to special-case the source.
  price: number;
  side: "support" | "resistance" | "neutral";
  strength: number; // 0..1
  tier?: number;
  method?: string;
  methods?: string[];
  reliability?: number;
  touches?: number;
  validated?: boolean;
  raw?: unknown; // escape hatch for source-specific fields
}

export interface LevelsRequest {
  symbol: string;
  interval: string; // backend interval string, e.g. "4H" / "1D"
}

export interface LevelsResponse {
  symbol: string;
  interval: string;
  levels: LevelItem[];
  updatedAt: string; // ISO
  raw?: unknown;     // full backend payload, for callers that want regime/etc
}

export interface LevelsDelta {
  symbol: string;
  levels: LevelItem[];
  updatedAt: string;
}

export interface DepthLevel {
  price: number;
  size: number;
  cumulative?: number;
  count?: number;
}

export interface DepthSnapshot {
  symbol: string;
  exchange: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  updatedAt: string;
}

// Liquidation cluster — a server-aggregated price bucket over a sliding
// window. The contract intentionally uses clusters (not raw events)
// because:
//   1. The chart and any future strategy module always wants the
//      bucketed view; raw events would force every consumer to re-bucket
//      on each tick.
//   2. The backend already does this aggregation and serves it via the
//      stable `/api/liquidity/liquidations/clusters` route; the datafeed
//      layer is a transport, so it surfaces the existing shape rather
//      than inventing a parallel one.
//   3. When/if a `liquidations:<SYM>` WS channel ships in the future,
//      it can deliver cluster snapshots / deltas in this same shape
//      without the consumer changing.
export interface LiqCluster {
  symbol: string;
  bucketPrice: number;
  bucketLow: number;
  bucketHigh: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
  sources: Record<string, number>; // exchange -> event count in bucket
  lastTs: number;                  // epoch ms of most recent event
}

export interface LiqClustersSnapshot {
  symbol: string;
  windowMs: number;
  bucketBps: number;
  clusters: LiqCluster[];
  source: string | null; // upstream feed reported by the API ("memory" today)
  updatedAt: string;     // ISO from backend
}

export interface Subscription {
  unsubscribe(): void;
}

export interface IDatafeed {
  // ── Symbols ───────────────────────────────────────────────────────────
  /** Paginated list. Optional exchange filter narrows to one venue. */
  listSymbols(opts?: {
    exchange?: string;
    limit?: number;
  }): Promise<{ items: SymbolInfo[]; total: number }>;

  /** Resolve one symbol by canonical UI ticker. Returns null if unknown. */
  getSymbol(ui: string): Promise<SymbolInfo | null>;

  /** Substring search. Backend caps at 30 results unless `limit` says otherwise. */
  searchSymbols(q: string, opts?: { limit?: number }): Promise<SymbolInfo[]>;

  // ── Candles ───────────────────────────────────────────────────────────
  /** REST fetch. Range mode (from+to) or limit mode. */
  fetchCandles(req: CandlesRequest): Promise<CandlesResponse>;

  /** Live bar stream with local rollover. See HttpDatafeed for semantics. */
  subscribeBars(req: BarsSubRequest, onBar: (bar: Bar) => void): Subscription;

  // ── Mark price ────────────────────────────────────────────────────────
  /** Raw mark-price ticks derived from heatmap channel. Single subscriber per
   *  symbol gets one tick per upstream message — no double delivery. */
  subscribeMark(
    symbol: string,
    onTick: (tick: MarkTick) => void,
  ): Subscription;

  // ── Levels ────────────────────────────────────────────────────────────
  fetchLevels(req: LevelsRequest): Promise<LevelsResponse>;
  subscribeLevels(
    symbol: string,
    onDelta: (delta: LevelsDelta) => void,
  ): Subscription;

  // ── Depth (orderbook ladder) ──────────────────────────────────────────
  subscribeDepth(
    symbol: string,
    onSnap: (snap: DepthSnapshot) => void,
  ): Subscription;

  // ── Liquidations ──────────────────────────────────────────────────────
  /** Internally polled stream over `/api/liquidity/liquidations/clusters`.
   *  Emits the latest cluster snapshot each tick. When/if the backend
   *  grows a `liquidations:<SYM>` WS channel, this switches to WS-driven
   *  snapshots/deltas without changing the consumer contract. */
  subscribeLiquidations(
    symbol: string,
    onSnapshot: (snap: LiqClustersSnapshot) => void,
    opts?: { intervalMs?: number; windowMs?: number; bucketBps?: number },
  ): Subscription;

  // ── Server time ───────────────────────────────────────────────────────
  /** Epoch ms reported by the api-server. Used for clock-skew compensation. */
  serverTime(): Promise<number>;
}
