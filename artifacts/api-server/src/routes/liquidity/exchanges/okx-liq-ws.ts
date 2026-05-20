// OKX public liquidation-orders WebSocket client.
//
// This is a *separate* WS connection from `okx-ws.ts` because the
// liquidation-orders channel is keyed by `instType` (one subscription covers
// all SWAP instruments), not by `instId`. Multiplexing it onto the per-symbol
// connection would conflate two very different subscription lifecycles.
//
// Each push is fanned out into a per-symbol ring buffer with a TTL so the
// /api/liquidations endpoint can serve recent events without hitting REST.

import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { enqueueLiquidation } from "../../../services/liquidationHistory/persistence";

const WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const INST_TYPES = ["SWAP"] as const;

// Keep ~30 minutes of liquidations per symbol. The endpoint returns a small
// limit (default 50, max ~200) so this is plenty of headroom.
const RETAIN_MS = 30 * 60_000;
const MAX_PER_SYMBOL = 500;
const ABSOLUTE_MAX_SYMBOLS = Math.max(128, Number(process.env.LIQ_EVENTS_MAX_SYMBOLS ?? "1200") || 1200);
const ACROSS_SYMBOL_LIMIT = Math.max(25, Number(process.env.LIQ_EVENTS_ACROSS_SYMBOL_LIMIT ?? "120") || 120);
const ACROSS_RESULT_LIMIT = Math.max(10, Number(process.env.LIQ_EVENTS_ACROSS_RESULT_LIMIT ?? "250") || 250);

export interface LiquidationEvent {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  /** ISO 8601 */
  timestamp: string;
  /** Epoch ms — kept for cheap sort/prune */
  ts: number;
  exchange: "okx";
}

const events = new Map<string, LiquidationEvent[]>();

// liqStoreBoundedAcrossV1: bound symbol keys and avoid full gather+sort for
// across-symbol snapshots. Display/storage only; does not affect engines.
function pruneEventArray(symbol: string, arr: LiquidationEvent[], cutoff = Date.now() - RETAIN_MS): void {
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

function pushNewestBounded(out: LiquidationEvent[], ev: LiquidationEvent, limit: number): void {
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

function fromInstId(instId: string): string {
  return instId.replace("-SWAP", "").replace(/-/g, "");
}

function pushEvent(ev: LiquidationEvent): void {
  let arr = events.get(ev.symbol);
  if (!arr) {
    arr = [];
    events.set(ev.symbol, arr);
  }
  arr.push(ev);
  // Mirror to the persistent log so windows beyond the in-memory ring
  // (~30 min) can be served from Postgres. Fire-and-forget; the
  // persistence module handles its own buffering and retries.
  enqueueLiquidation({
    id: ev.id,
    exchange: "okx",
    symbol: ev.symbol,
    side: ev.side,
    price: ev.price,
    size: ev.size,
    usdValue: ev.usdValue,
    ts: ev.ts,
  });
  // Prune by age + cap. Walk from the front (oldest).
  const cutoff = Date.now() - RETAIN_MS;
  let drop = 0;
  while (drop < arr.length && arr[drop]!.ts < cutoff) drop++;
  if (drop > 0) arr.splice(0, drop);
  if (arr.length > MAX_PER_SYMBOL) {
    arr.splice(0, arr.length - MAX_PER_SYMBOL);
  }
}

/** Returns up to `limit` most-recent liquidations, newest first. */
export function getLiquidations(symbol: string, limit: number): LiquidationEvent[] {
  const arr = events.get(symbol);
  if (!arr || arr.length === 0) return [];
  // Filter expired in case the symbol stopped pushing for a while.
  const cutoff = Date.now() - RETAIN_MS;
  const fresh = arr.filter((e) => e.ts >= cutoff);
  if (fresh.length !== arr.length) events.set(symbol, fresh);
  // Newest first.
  return fresh.slice(-limit).reverse();
}

/** Snapshot across many symbols, newest first, capped at `limit` total. */
export function getRecentLiquidationsAcross(
  symbols: string[],
  limit: number,
): LiquidationEvent[] {
  const cappedLimit = Math.max(0, Math.min(ACROSS_RESULT_LIMIT, Math.floor(limit)));
  if (cappedLimit <= 0) return [];
  const cutoff = Date.now() - RETAIN_MS;
  const merged: LiquidationEvent[] = [];
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

interface OkxLiqDetail {
  side?: string;       // "buy" | "sell" — the order side placed by the liq engine
  posSide?: string;    // "long" | "short" — the position that got liquidated
  bkPx?: string;       // bankruptcy/liq price
  sz?: string;         // size in contracts
  ts?: string;         // epoch ms (string)
  ccy?: string;
}

interface OkxLiqRow {
  instId?: string;
  instFamily?: string;
  details?: OkxLiqDetail[];
}

interface OkxLiqMsg {
  event?: string;
  arg?: { channel?: string; instType?: string };
  data?: OkxLiqRow[];
  msg?: string;
  code?: string;
}

function inferSide(d: OkxLiqDetail): "long" | "short" | null {
  const ps = (d.posSide || "").toLowerCase();
  if (ps === "long") return "long";
  if (ps === "short") return "short";
  // Fallback: in one-way mode posSide may be "net". The order side placed
  // *by* the liquidation engine is the opposite of the position liquidated.
  const s = (d.side || "").toLowerCase();
  if (s === "sell") return "long";   // selling closes a long => long got liq'd
  if (s === "buy") return "short";   // buying closes a short => short got liq'd
  return null;
}

function handleMessage(msg: OkxLiqMsg): void {
  if (msg.event === "error") {
    logger.warn(
      { exchange: "okx-liq", code: msg.code, msg: msg.msg },
      "okx-liq-ws: error event",
    );
    return;
  }
  if (msg.event === "subscribe" || msg.event === "unsubscribe") return;
  if (!msg.arg || msg.arg.channel !== "liquidation-orders") return;
  if (!Array.isArray(msg.data)) return;

  for (const row of msg.data) {
    if (!row.instId || !Array.isArray(row.details)) continue;
    const symbol = fromInstId(row.instId);
    for (const d of row.details) {
      const side = inferSide(d);
      const price = parseFloat(d.bkPx ?? "");
      const size = parseFloat(d.sz ?? "");
      const ts = parseInt(d.ts ?? "", 10);
      if (!side || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) {
        continue;
      }
      const usdValue = price * size;
      pushEvent({
        id: `okx-${row.instId}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        side,
        price,
        size,
        usdValue,
        timestamp: new Date(ts).toISOString(),
        ts,
        exchange: "okx",
      });
    }
  }
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
  logger.info({ exchange: "okx-liq", delay }, "okx-liq-ws: reconnecting");
}

function subscribe(): void {
  if (!ws || !connected) return;
  const args = INST_TYPES.map((instType) => ({
    channel: "liquidation-orders",
    instType,
  }));
  ws.send(JSON.stringify({ op: "subscribe", args }));
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
  logger.info({ exchange: "okx-liq" }, "okx-liq-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info({ exchange: "okx-liq" }, "okx-liq-ws: connected");
    subscribe();
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    if (text === "pong") {
      lastPongAt = Date.now();
      return;
    }
    try {
      const msg = JSON.parse(text) as OkxLiqMsg;
      const before = totalEvents;
      // Count events by hooking into pushEvent path: cheap to count post-parse.
      handleMessage(msg);
      // Track activity: if any data row had at least one detail we consider
      // it an event push. We re-derive count here for the health endpoint.
      if (Array.isArray(msg.data)) {
        for (const r of msg.data) {
          if (Array.isArray(r.details)) totalEvents += r.details.length;
        }
      }
      if (totalEvents !== before) lastEventAt = Date.now();
    } catch (err) {
      logger.warn(
        { exchange: "okx-liq", err: String(err), preview: text.slice(0, 200) },
        "okx-liq-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    logger.warn(
      { exchange: "okx-liq", code, reason: reason.toString() },
      "okx-liq-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "okx-liq", err: err.message }, "okx-liq-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && connected) {
      try {
        ws.send("ping");
      } catch {
        // ignore
      }
      if (lastPongAt && Date.now() - lastPongAt > 60_000) {
        logger.warn({ exchange: "okx-liq" }, "okx-liq-ws: pong timeout, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, 20_000);
}

export function startOkxLiqWs(): void {
  if (started) return;
  started = true;
  connect();
  startPingLoop();
}

export function isOkxLiqWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastPongAt) return false;
  return Date.now() - lastPongAt < 60_000;
}

export function getOkxLiqWsHealth() {
  return {
    connected,
    healthy: isOkxLiqWsHealthy(),
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
    lastEventAgeMs: lastEventAt ? Date.now() - lastEventAt : null,
    symbolsWithEvents: events.size,
    totalEvents,
  };
}
