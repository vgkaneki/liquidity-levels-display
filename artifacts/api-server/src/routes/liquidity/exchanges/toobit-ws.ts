// Toobit USDT perps — WebSocket client for live ticker + depth (Phase B).
//
// Self-contained: keeps its own in-memory store and never touches the
// OKX/HL ws-store. Subscriptions are added on demand when a route is hit
// for a given symbol; nothing is pinned at startup. No polling loops.

import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { fetchInstruments } from "./toobit";
import * as symbolRegistry from "../../../services/symbolRegistry";
import { logDisagreement } from "../../../services/symbolRegistry/disagreementLog";

const WS_URL = "wss://stream.toobit.com/quote/ws/v1";
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 60_000;

interface TickerSnap {
  last: number;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  open24h: number | null;
  volume24h: number | null;
  ts: number;
}

interface BookSnap {
  bids: [number, number][];
  asks: [number, number][];
  ts: number;
}

const tickers = new Map<string, TickerSnap>();    // key: native symbol
const books = new Map<string, BookSnap>();        // key: native symbol
const subscribed = new Set<string>();
let validSymbols: Set<string> | null = null;       // native Toobit symbols
const nativeFromUi = new Map<string, string>();    // BTCUSDT -> BTC-SWAP-USDT

let ws: WebSocket | null = null;
let connected = false;
let started = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
let lastConnectedAt = 0;

function backoffMs(): number {
  return Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  logger.info({ exchange: "toobit", delay }, "toobit-ws: reconnecting");
}

async function loadUniverse(): Promise<void> {
  const list = await fetchInstruments();
  if (!list || list.length === 0) {
    logger.warn({ exchange: "toobit" }, "toobit-ws: empty universe; will retry");
    return;
  }
  validSymbols = new Set(list.map((i) => i.symbol));
  nativeFromUi.clear();
  for (const i of list) nativeFromUi.set(i.uiSymbol, i.symbol);
  logger.info(
    { exchange: "toobit", count: validSymbols.size },
    "toobit-ws: loaded perp universe (USDT-margined only)",
  );
}

async function loadUntilReady(): Promise<void> {
  while (!validSymbols) {
    await loadUniverse();
    if (!validSymbols) await new Promise((r) => setTimeout(r, 5_000));
  }
}

function sendSub(nativeSymbol: string, topic: string): void {
  if (!ws || !connected) return;
  ws.send(JSON.stringify({ symbol: nativeSymbol, topic, event: "sub" }));
}

function subscribeAll(nativeSymbol: string): void {
  sendSub(nativeSymbol, "realtimes");
  sendSub(nativeSymbol, "depth");
}

/**
 * Resolve a UI symbol (BTCUSDT) to Toobit's native symbol and ensure the WS
 * is subscribed for ticker + depth. Safe to call repeatedly.
 */
export function ensureSubscribed(uiSymbol: string): boolean {
  const native = nativeFromUi.get(uiSymbol.toUpperCase());
  if (!native) return false;
  if (subscribed.has(native)) return true;
  subscribed.add(native);
  if (connected) subscribeAll(native);
  return true;
}

interface ToobitWsMsg {
  topic?: string;
  symbol?: string;
  data?: unknown;
  ping?: number;
  pong?: number;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function handleMessage(msg: ToobitWsMsg): void {
  if (typeof msg.ping === "number") {
    if (ws && connected) {
      try { ws.send(JSON.stringify({ pong: msg.ping })); } catch { /* ignore */ }
    }
    lastPongAt = Date.now();
    return;
  }
  if (typeof msg.pong === "number") {
    lastPongAt = Date.now();
    return;
  }
  const native = (msg.symbol || "").toString().toUpperCase();
  const topic = msg.topic;
  const payload = msg.data;
  if (!native || !topic || payload === undefined) return;

  const row = Array.isArray(payload) ? (payload[0] as Record<string, unknown> | undefined) : (payload as Record<string, unknown>);
  if (!row || typeof row !== "object") return;

  if (topic === "realtimes") {
    const last = num(row.c ?? row.last ?? row.lastPrice);
    if (last === null) return;
    tickers.set(native, {
      last,
      bid: num(row.b ?? row.bid ?? row.bestBid),
      ask: num(row.a ?? row.ask ?? row.bestAsk),
      high24h: num(row.h ?? row.high ?? row.highPrice),
      low24h: num(row.l ?? row.low ?? row.lowPrice),
      open24h: num(row.o ?? row.open ?? row.openPrice),
      volume24h: num(row.v ?? row.volume ?? row.qv),
      ts: Date.now(),
    });
  } else if (topic === "depth") {
    const bidsRaw = (row.b ?? row.bids ?? []) as string[][];
    const asksRaw = (row.a ?? row.asks ?? []) as string[][];
    const parse = (rows: unknown): [number, number][] => {
      if (!Array.isArray(rows)) return [];
      const out: [number, number][] = [];
      for (const r of rows) {
        if (!Array.isArray(r)) continue;
        const p = num(r[0]);
        const s = num(r[1]);
        if (p !== null && s !== null) out.push([p, s]);
      }
      return out;
    };
    books.set(native, { bids: parse(bidsRaw), asks: parse(asksRaw), ts: Date.now() });
  }
}

function connect(): void {
  if (ws) {
    try { ws.removeAllListeners(); ws.terminate(); } catch { /* ignore */ }
    ws = null;
  }
  logger.info({ exchange: "toobit" }, "toobit-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info({ exchange: "toobit", subscriptions: subscribed.size }, "toobit-ws: connected");
    for (const native of subscribed) subscribeAll(native);
  });

  ws.on("message", (raw) => {
    let text: string;
    try { text = raw.toString(); } catch { return; }
    if (text === "pong") { lastPongAt = Date.now(); return; }
    try {
      const msg = JSON.parse(text);
      handleMessage(msg);
    } catch (err) {
      logger.warn(
        { exchange: "toobit", err: String(err), preview: text.slice(0, 200) },
        "toobit-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    logger.warn(
      { exchange: "toobit", code, reason: reason.toString() },
      "toobit-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "toobit", err: err.message }, "toobit-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && connected) {
      try { ws.send(JSON.stringify({ ping: Date.now() })); } catch { /* ignore */ }
      if (lastPongAt && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        logger.warn({ exchange: "toobit" }, "toobit-ws: pong timeout, terminating");
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  }, PING_INTERVAL_MS);
}

/**
 * Idempotent. Loads the universe (USDT perps only), opens the WS, and starts
 * the ping loop. Refresh universe hourly so newly-listed perps are eligible.
 */
export function startToobitWs(): void {
  if (started) return;
  started = true;
  void loadUntilReady();
  setInterval(() => void loadUniverse(), 60 * 60_000);
  connect();
  startPingLoop();
}

export function getToobitTicker(uiSymbol: string): TickerSnap | null {
  const native = nativeFromUi.get(uiSymbol.toUpperCase());
  if (!native) return null;
  return tickers.get(native) ?? null;
}

export function getToobitBook(uiSymbol: string): BookSnap | null {
  const native = nativeFromUi.get(uiSymbol.toUpperCase());
  if (!native) return null;
  return books.get(native) ?? null;
}

export function listUniverse(): { symbol: string; uiSymbol: string; baseAsset: string }[] {
  if (!validSymbols) return [];
  const out: { symbol: string; uiSymbol: string; baseAsset: string }[] = [];
  for (const [ui, native] of nativeFromUi.entries()) {
    out.push({ symbol: native, uiSymbol: ui, baseAsset: ui.replace(/USDT$/, "") });
  }
  return out;
}

export function isToobitSupported(uiSymbol: string): boolean {
  const ui = uiSymbol.toUpperCase();
  const reg = symbolRegistry.isListed(ui, "toobit");
  const legacy = nativeFromUi.has(ui);
  if (reg === "yes") {
    if (nativeFromUi.size > 0 && !legacy) {
      logDisagreement("toobitWs.isToobitSupported", ui, true, false);
    }
    return true;
  }
  if (reg === "no") {
    if (legacy) {
      logDisagreement("toobitWs.isToobitSupported", ui, false, true);
    }
    return false;
  }
  return legacy;
}

export function getToobitWsHealth() {
  return {
    enabled: true,
    connected,
    universeSize: validSymbols?.size ?? null,
    subscriptions: subscribed.size,
    cachedTickers: tickers.size,
    cachedBooks: books.size,
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
  };
}
