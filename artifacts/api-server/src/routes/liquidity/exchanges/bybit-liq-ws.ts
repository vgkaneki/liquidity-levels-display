// Bybit V5 public liquidation WebSocket client.
//
// Bybit publishes liquidations on the per-symbol `allLiquidation.{symbol}`
// channel (the legacy `liquidation.{symbol}` channel is deprecated). Like
// the Hyperliquid trades feed we keep subscriptions in sync with the
// active symbol set rather than spraying the entire universe up-front.
//
// Each push is fanned out into a per-symbol ring buffer with a TTL so the
// /api/liquidations endpoint can serve recent events without hitting REST.

import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { listActive, isActive } from "./ws-store";
import { enqueueLiquidation } from "../../../services/liquidationHistory/persistence";

const WS_URL = "wss://stream.bybit.com/v5/public/linear";

// Mirror the OKX/HL ring sizing so the merge layer treats every source the
// same: ~30 minutes retention, capped per symbol.
const RETAIN_MS = 30 * 60_000;
const MAX_PER_SYMBOL = 500;
const ABSOLUTE_MAX_SYMBOLS = Math.max(128, Number(process.env.LIQ_EVENTS_MAX_SYMBOLS ?? "1200") || 1200);
const ACROSS_SYMBOL_LIMIT = Math.max(25, Number(process.env.LIQ_EVENTS_ACROSS_SYMBOL_LIMIT ?? "120") || 120);
const ACROSS_RESULT_LIMIT = Math.max(10, Number(process.env.LIQ_EVENTS_ACROSS_RESULT_LIMIT ?? "250") || 250);

export interface BybitLiquidationEvent {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  timestamp: string;
  ts: number;
  exchange: "bybit";
}

const events = new Map<string, BybitLiquidationEvent[]>();

// liqStoreBoundedAcrossV1: bound symbol keys and avoid full gather+sort for
// across-symbol snapshots. Display/storage only; does not affect engines.
function pruneEventArray(symbol: string, arr: BybitLiquidationEvent[], cutoff = Date.now() - RETAIN_MS): void {
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

function pushNewestBounded(out: BybitLiquidationEvent[], ev: BybitLiquidationEvent, limit: number): void {
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

function pushEvent(ev: BybitLiquidationEvent): void {
  let arr = events.get(ev.symbol);
  if (!arr) {
    arr = [];
    events.set(ev.symbol, arr);
  }
  arr.push(ev);
  enqueueLiquidation({
    id: ev.id,
    exchange: "bybit",
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

export function getBybitLiquidations(symbol: string, limit: number): BybitLiquidationEvent[] {
  const arr = events.get(symbol);
  if (!arr || arr.length === 0) return [];
  pruneEventArray(symbol, arr);
  const fresh = events.get(symbol);
  if (!fresh || fresh.length === 0) return [];
  return fresh.slice(-limit).reverse();
}

export function getRecentBybitLiquidationsAcross(
  symbols: string[],
  limit: number,
): BybitLiquidationEvent[] {
  const cappedLimit = Math.max(0, Math.min(ACROSS_RESULT_LIMIT, Math.floor(limit)));
  if (cappedLimit <= 0) return [];
  const cutoff = Date.now() - RETAIN_MS;
  const merged: BybitLiquidationEvent[] = [];
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

interface BybitLiqRow {
  T?: number;   // event time (ms)
  s?: string;   // symbol, e.g. "BTCUSDT"
  S?: string;   // order side that crossed: "Buy" | "Sell"
  v?: string;   // size in base units
  p?: string;   // price
}
interface BybitWsMsg {
  topic?: string;
  type?: string;
  ts?: number;
  data?: BybitLiqRow[] | BybitLiqRow;
  op?: string;
  success?: boolean;
  ret_msg?: string;
  conn_id?: string;
}

function inferSide(s: string): "long" | "short" | null {
  // The S field is the side of the *liquidation order* placed by the
  // engine. A Sell order closes a long => long got liquidated. A Buy
  // order closes a short => short got liquidated. Same convention as
  // okx-liq-ws.ts inferSide().
  const v = s.toLowerCase();
  if (v === "sell") return "long";
  if (v === "buy") return "short";
  return null;
}

function handleRow(symbol: string, row: BybitLiqRow): void {
  if (!row.S || !row.v || !row.p || !row.T) return;
  if (!isActive(symbol)) return;
  const side = inferSide(row.S);
  const price = parseFloat(row.p);
  const size = parseFloat(row.v);
  const ts = row.T;
  if (!side || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return;
  const usdValue = price * size;
  pushEvent({
    id: `bybit-${symbol}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    price,
    size,
    usdValue,
    timestamp: new Date(ts).toISOString(),
    ts,
    exchange: "bybit",
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
const subscribed = new Set<string>();

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
  logger.info({ exchange: "bybit-liq", delay }, "bybit-liq-ws: reconnecting");
}

function send(payload: unknown): void {
  if (!ws || !connected) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ exchange: "bybit-liq", err: String(err) }, "bybit-liq-ws: send error");
  }
}

// Throttled outbound queue. Bybit accepts up to 10 args per `subscribe`
// frame and rate-limits aggressive bursts; we drip out batches of 10 with
// a small delay so a fresh connection with hundreds of warm symbols
// doesn't get rejected.
const SUB_QUEUE_MAX = Math.max(50, Number(process.env.BYBIT_LIQ_SUB_QUEUE_MAX ?? "300") || 300);
const subQueue: (() => void)[] = [];
const queuedSubOps = new Set<string>();
let pumping = false;
function pumpSubQueue(): void {
  if (pumping) return;
  pumping = true;
  const tick = () => {
    if (subQueue.length === 0 || !connected) {
      pumping = false;
      return;
    }
    const op = subQueue.shift();
    if (op) op();
    setTimeout(tick, 100);
  };
  tick();
}

function queueSubOp(key: string, op: () => void): void {
  if (queuedSubOps.has(key)) return;
  if (subQueue.length >= SUB_QUEUE_MAX) {
    logger.warn({ exchange: "bybit-liq", queued: subQueue.length, max: SUB_QUEUE_MAX }, "bybit-liq-ws: subscription queue full");
    return;
  }
  queuedSubOps.add(key);
  subQueue.push(() => {
    queuedSubOps.delete(key);
    op();
  });
  pumpSubQueue();
}

function subscribeSymbols(syms: string[]): void {
  if (syms.length === 0) return;
  // One arg per frame: Bybit rejects the entire frame if a single symbol
  // isn't listed on the linear venue (TRUMPUSDT, POLUSDT, etc.). The
  // throttled queue absorbs the extra frames cheaply.
  for (const sym of syms) {
    queueSubOp(`sub:${sym}`, () => send({ op: "subscribe", args: [`allLiquidation.${sym}`] }));
  }
}

function unsubscribeSymbols(syms: string[]): void {
  if (syms.length === 0) return;
  for (const sym of syms) {
    queueSubOp(`unsub:${sym}`, () => send({ op: "unsubscribe", args: [`allLiquidation.${sym}`] }));
  }
}

function reconcileSubs(): void {
  const targets = new Set(listActive());
  const toRemove: string[] = [];
  for (const sym of subscribed) {
    if (!targets.has(sym)) {
      subscribed.delete(sym);
      toRemove.push(sym);
    }
  }
  const toAdd: string[] = [];
  for (const sym of targets) {
    if (!subscribed.has(sym)) {
      subscribed.add(sym);
      toAdd.push(sym);
    }
  }
  if (connected) {
    if (toRemove.length > 0) unsubscribeSymbols(toRemove);
    if (toAdd.length > 0) subscribeSymbols(toAdd);
  }
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
  logger.info({ exchange: "bybit-liq" }, "bybit-liq-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info({ exchange: "bybit-liq" }, "bybit-liq-ws: connected");
    // Replay all known subs through the throttled queue, then merge in
    // any newly active symbols.
    if (subscribed.size > 0) {
      subscribeSymbols(Array.from(subscribed));
    }
    reconcileSubs();
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    try {
      const msg = JSON.parse(text) as BybitWsMsg;
      lastPongAt = Date.now();
      if (msg.op === "pong" || msg.op === "ping") return;
      if (msg.op === "subscribe" || msg.op === "unsubscribe") {
        if (msg.success === false) {
          // Bybit rejects subscriptions for symbols not listed on the
          // linear venue (e.g. TRUMPUSDT). These are expected and don't
          // affect the rest of the symbol set, so we log at debug.
          logger.debug(
            {
              exchange: "bybit-liq",
              op: msg.op,
              ret_msg: msg.ret_msg,
              conn_id: msg.conn_id,
            },
            "bybit-liq-ws: subscribe rejected (likely unlisted symbol)",
          );
        }
        return;
      }
      if (!msg.topic || !msg.topic.startsWith("allLiquidation.")) return;
      const symbol = msg.topic.slice("allLiquidation.".length).toUpperCase();
      const rows = Array.isArray(msg.data) ? msg.data : msg.data ? [msg.data] : [];
      const before = totalEvents;
      for (const row of rows) handleRow(symbol, row);
      totalEvents += rows.length;
      if (totalEvents !== before) lastEventAt = Date.now();
    } catch (err) {
      logger.warn(
        { exchange: "bybit-liq", err: String(err), preview: text.slice(0, 200) },
        "bybit-liq-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    logger.warn(
      { exchange: "bybit-liq", code, reason: reason.toString() },
      "bybit-liq-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "bybit-liq", err: err.message }, "bybit-liq-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  // Bybit recommends a ping every 20s; their docs say ≤30s before the
  // server force-closes the socket.
  pingTimer = setInterval(() => {
    if (ws && connected) {
      try {
        ws.send(JSON.stringify({ op: "ping" }));
      } catch {
        // ignore
      }
      if (lastPongAt && Date.now() - lastPongAt > 60_000) {
        logger.warn({ exchange: "bybit-liq" }, "bybit-liq-ws: pong timeout, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
    reconcileSubs();
  }, 20_000);
}

export function startBybitLiqWs(): void {
  if (started) return;
  started = true;
  connect();
  startPingLoop();
}

export function isBybitLiqWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastPongAt) return false;
  return Date.now() - lastPongAt < 60_000;
}

export function getBybitLiqWsHealth() {
  return {
    connected,
    healthy: isBybitLiqWsHealthy(),
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
    lastEventAgeMs: lastEventAt ? Date.now() - lastEventAt : null,
    symbolsWithEvents: events.size,
    subscribedSymbols: subscribed.size,
    totalEvents,
  };
}
