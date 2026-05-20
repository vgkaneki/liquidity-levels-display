// Binance USDT-margined futures public liquidation WebSocket client.
//
// Binance publishes the market-wide forced-order stream at a single
// endpoint (`!forceOrder@arr`) — one connection covers every USDT-M
// perpetual, no per-symbol subscriptions required. This mirrors the OKX
// liquidation-orders channel structure and keeps this module simple.
//
// Each push is fanned out into a per-symbol ring buffer with a TTL so the
// /api/liquidations endpoint can serve recent events without hitting REST.

import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { enqueueLiquidation } from "../../../services/liquidationHistory/persistence";

const WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";

const RETAIN_MS = 30 * 60_000;
const MAX_PER_SYMBOL = 500;
const ABSOLUTE_MAX_SYMBOLS = Math.max(128, Number(process.env.LIQ_EVENTS_MAX_SYMBOLS ?? "1200") || 1200);
const ACROSS_SYMBOL_LIMIT = Math.max(25, Number(process.env.LIQ_EVENTS_ACROSS_SYMBOL_LIMIT ?? "120") || 120);
const ACROSS_RESULT_LIMIT = Math.max(10, Number(process.env.LIQ_EVENTS_ACROSS_RESULT_LIMIT ?? "250") || 250);

export interface BinanceLiquidationEvent {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  timestamp: string;
  ts: number;
  exchange: "binance";
}

const events = new Map<string, BinanceLiquidationEvent[]>();

// liqStoreBoundedAcrossV1: bound symbol keys and avoid full gather+sort for
// across-symbol snapshots. Display/storage only; does not affect engines.
function pruneEventArray(symbol: string, arr: BinanceLiquidationEvent[], cutoff = Date.now() - RETAIN_MS): void {
  let drop = 0;
  while (drop < arr.length && arr[drop]!.ts < cutoff) drop++;
  if (drop > 0) arr.splice(0, drop);
  if (arr.length > MAX_PER_SYMBOL) arr.splice(0, arr.length - MAX_PER_SYMBOL);
  if (arr.length === 0) events.delete(symbol);
}

function evictOldestSymbolKeys(): void {
  if (events.size <= ABSOLUTE_MAX_SYMBOLS) return;
  const ranked = Array.from(events.entries())
    .map(([symbol, arr]) => ({ symbol, newest: arr.length ? arr[arr.length - 1]!.ts : 0 }))
    .sort((a, b) => a.newest - b.newest);
  for (const item of ranked) {
    if (events.size <= ABSOLUTE_MAX_SYMBOLS) break;
    events.delete(item.symbol);
  }
}

function pushNewestBounded(out: BinanceLiquidationEvent[], ev: BinanceLiquidationEvent, limit: number): void {
  if (limit <= 0) return;
  if (out.length < limit) {
    out.push(ev);
    if (out.length === limit) out.sort((a, b) => a.ts - b.ts);
    return;
  }
  if (ev.ts <= out[0]!.ts) return;
  out[0] = ev;
  out.sort((a, b) => a.ts - b.ts);
}

function pushEvent(ev: BinanceLiquidationEvent): void {
  let arr = events.get(ev.symbol);
  if (!arr) {
    arr = [];
    events.set(ev.symbol, arr);
  }
  arr.push(ev);
  enqueueLiquidation({
    id: ev.id,
    exchange: "binance",
    symbol: ev.symbol,
    side: ev.side,
    price: ev.price,
    size: ev.size,
    usdValue: ev.usdValue,
    ts: ev.ts,
  });
  pruneEventArray(ev.symbol, arr);
  evictOldestSymbolKeys();
}

export function getBinanceLiquidations(symbol: string, limit: number): BinanceLiquidationEvent[] {
  const arr = events.get(symbol);
  if (!arr || arr.length === 0) return [];
  pruneEventArray(symbol, arr);
  const fresh = events.get(symbol);
  if (!fresh || fresh.length === 0) return [];
  return fresh.slice(-limit).reverse();
}

export function getRecentBinanceLiquidationsAcross(
  symbols: string[],
  limit: number,
): BinanceLiquidationEvent[] {
  const cappedLimit = Math.max(0, Math.min(ACROSS_RESULT_LIMIT, Math.floor(limit)));
  if (cappedLimit <= 0) return [];
  const cutoff = Date.now() - RETAIN_MS;
  const merged: BinanceLiquidationEvent[] = [];
  for (const s of symbols.slice(0, ACROSS_SYMBOL_LIMIT)) {
    const arr = events.get(s);
    if (!arr) continue;
    pruneEventArray(s, arr, cutoff);
    const fresh = events.get(s);
    if (!fresh) continue;
    for (const e of fresh) {
      if (e.ts >= cutoff) pushNewestBounded(merged, e, cappedLimit);
    }
  }
  return merged.sort((a, b) => b.ts - a.ts);
}

interface BinanceForceOrder {
  s?: string;   // symbol, e.g. "BTCUSDT"
  S?: string;   // side of the liq order: "BUY" | "SELL"
  o?: string;   // order type
  f?: string;   // time in force
  q?: string;   // original quantity
  p?: string;   // price
  ap?: string;  // average price
  X?: string;   // order status
  l?: string;   // last filled qty
  z?: string;   // accumulated filled qty
  T?: number;   // trade time (ms)
}
interface BinanceForceOrderMsg {
  e?: string;   // "forceOrder"
  E?: number;   // event time
  o?: BinanceForceOrder;
}

function inferSide(s: string): "long" | "short" | null {
  // S is the order side placed by the liquidation engine. SELL closes a
  // long => long got liquidated; BUY closes a short => short got
  // liquidated. Matches the okx-liq-ws.ts convention.
  const v = s.toUpperCase();
  if (v === "SELL") return "long";
  if (v === "BUY") return "short";
  return null;
}

function handleOrder(o: BinanceForceOrder): void {
  if (!o.s || !o.S || !o.T) return;
  const symbol = o.s.toUpperCase();
  const side = inferSide(o.S);
  // Prefer average fill price when available, fall back to the order price.
  const price = parseFloat(o.ap ?? o.p ?? "");
  // Use accumulated filled qty when present so partial-fill events are
  // valued at what actually crossed the book; fall back to original qty.
  const size = parseFloat(o.z ?? o.q ?? "");
  const ts = o.T;
  if (!side || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return;
  if (price <= 0 || size <= 0) return;
  const usdValue = price * size;
  pushEvent({
    id: `binance-${symbol}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    price,
    size,
    usdValue,
    timestamp: new Date(ts).toISOString(),
    ts,
    exchange: "binance",
  });
}

let ws: WebSocket | null = null;
let connected = false;
let started = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
let lastConnectedAt = 0;
let lastEventAt = 0;
let totalEvents = 0;

function backoffMs(): number {
  const base = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));
  const jitter = Math.floor(Math.random() * Math.min(2_500, Math.max(250, base * 0.1)));
  return base + jitter;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  logger.info({ exchange: "binance-liq", delay }, "binance-liq-ws: reconnecting");
}

function connect(): void {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {
      // ignore
    }
    ws = null;
  }
  logger.info({ exchange: "binance-liq" }, "binance-liq-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info({ exchange: "binance-liq" }, "binance-liq-ws: connected");
    // No subscribe frame needed: the connection URL includes the stream.
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    try {
      const msg = JSON.parse(text) as BinanceForceOrderMsg;
      lastPongAt = Date.now();
      if (msg.e !== "forceOrder" || !msg.o) return;
      const before = totalEvents;
      handleOrder(msg.o);
      totalEvents += 1;
      if (totalEvents !== before) lastEventAt = Date.now();
    } catch (err) {
      logger.warn(
        { exchange: "binance-liq", err: String(err), preview: text.slice(0, 200) },
        "binance-liq-ws: parse error",
      );
    }
  });

  // Binance servers send pings every ~3 minutes and expect a pong
  // back within 10 minutes, otherwise they disconnect. The `ws`
  // library auto-replies to ping frames out of the box, so we just
  // track liveness via inbound traffic.
  ws.on("ping", () => {
    lastPongAt = Date.now();
  });
  ws.on("pong", () => {
    lastPongAt = Date.now();
  });

  ws.on("close", (code, reason) => {
    connected = false;
    logger.warn(
      { exchange: "binance-liq", code, reason: reason.toString() },
      "binance-liq-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "binance-liq", err: err.message }, "binance-liq-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  // Send a client ping every 30s as a liveness probe. Even though Binance
  // initiates the keepalive ping, an idle stream can otherwise leave us
  // with no `lastPongAt` updates for minutes, masking a dead socket.
  pingTimer = setInterval(() => {
    if (ws && connected) {
      try {
        ws.ping();
      } catch {
        // ignore
      }
      // !forceOrder@arr is event-driven and can legitimately be silent for
      // many minutes during quiet markets, so the staleness threshold is
      // looser than per-symbol channels (15 min vs 60s elsewhere).
      if (lastPongAt && Date.now() - lastPongAt > 15 * 60_000) {
        logger.warn({ exchange: "binance-liq" }, "binance-liq-ws: stream idle, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, 30_000);
}

export function startBinanceLiqWs(): void {
  if (started) return;
  started = true;
  connect();
  startPingLoop();
}

export function isBinanceLiqWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastPongAt) return false;
  // Same looser staleness threshold as the ping loop — quiet markets
  // shouldn't flag the socket as unhealthy.
  return Date.now() - lastPongAt < 15 * 60_000;
}

export function getBinanceLiqWsHealth() {
  return {
    connected,
    healthy: isBinanceLiqWsHealthy(),
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
    lastEventAgeMs: lastEventAt ? Date.now() - lastEventAt : null,
    symbolsWithEvents: events.size,
    totalEvents,
  };
}
