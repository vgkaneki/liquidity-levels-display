import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { okxStore, listActive, isActive, pruneTouches } from "./ws-store";
import { addTrade, forgetTrades } from "./trades-store";
import {
  fetchInstruments,
  type OkxOrderbook,
  type OkxBookLevel,
  type OkxTicker,
  type OkxFunding,
  type OkxOpenInterest,
} from "./okx";
import * as symbolRegistry from "../../../services/symbolRegistry";
import { logDisagreement } from "../../../services/symbolRegistry/disagreementLog";

const WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const CHANNELS = ["books", "tickers", "funding-rate", "open-interest", "trades"] as const;

function toInstId(symbol: string): string {
  const clean = symbol.replace(/-/g, "").toUpperCase();
  const base = clean.replace(/USDT$/, "");
  const legacy = `${base}-USDT-SWAP`;
  const fromRegistry = symbolRegistry.toNative(symbol, "okx");
  if (fromRegistry && fromRegistry !== legacy) {
    logDisagreement("okxWs.toInstId", symbol, fromRegistry, legacy);
  }
  return fromRegistry ?? legacy;
}

function fromInstId(instId: string): string {
  const legacy = instId.replace("-SWAP", "").replace(/-/g, "");
  const fromRegistry = symbolRegistry.fromNative(instId, "okx");
  if (fromRegistry && fromRegistry !== legacy) {
    logDisagreement("okxWs.fromInstId", instId, fromRegistry, legacy);
  }
  return fromRegistry ?? legacy;
}

interface BookState {
  bids: Map<number, OkxBookLevel>;
  asks: Map<number, OkxBookLevel>;
}

const bookState = new Map<string, BookState>();
const subscribed = new Set<string>();

// Universe of OKX-supported perp symbols. Loaded once on startup and
// refreshed periodically. Until it loads we optimistically allow attempts
// (matches the Hyperliquid client's behavior).
let validSymbols: Set<string> | null = null;

async function loadValidUniverse(): Promise<void> {
  const list = await fetchInstruments();
  if (!list || list.length === 0) {
    logger.warn({ exchange: "okx" }, "okx-ws: instrument universe empty; will retry");
    return;
  }
  validSymbols = new Set(list.map((i) => i.symbol));
  logger.info(
    { exchange: "okx", count: validSymbols.size },
    "okx-ws: loaded valid symbol universe",
  );
  // Anything that got subscribed during the cold-start window (notably the
  // pinned scanner symbols) but isn't actually listed on OKX must be evicted
  // here; otherwise pinned HL-only symbols would stay subscribed forever.
  pruneUnsupportedSubscriptions();
}

function pruneUnsupportedSubscriptions(): void {
  if (!validSymbols) return;
  const drop: string[] = [];
  for (const s of subscribed) {
    if (!validSymbols.has(s)) drop.push(s);
  }
  if (drop.length === 0) return;
  for (const s of drop) {
    subscribed.delete(s);
    bookState.delete(toInstId(s));
    okxStore.forget(s);
    forgetTrades(s);
  }
  if (connected) sendOp("unsubscribe", drop);
  logger.info({ exchange: "okx", count: drop.length }, "okx-ws: pruned unsupported symbols");
}

// Cold-start retry loop: if the first instrument fetch fails, try again every
// 5s until it succeeds, so the unknown-universe window stays short. Only the
// initial load is fast-retried; the hourly refresh handles steady state.
async function loadUntilReady(): Promise<void> {
  while (!validSymbols) {
    await loadValidUniverse();
    if (!validSymbols) await new Promise((r) => setTimeout(r, 5_000));
  }
}

// True if the symbol is in OKX's perp universe, OR if the universe has not
// loaded yet (so first-boot reads aren't dropped). Once loaded, unsupported
// symbols (e.g. HL-only listings) are filtered out everywhere.
export function isOkxSupported(symbol: string): boolean {
  // Phase 1 SymbolRegistry primary; legacy validSymbols set is the
  // fallback so behavior is preserved while the registry warms.
  const reg = symbolRegistry.isListed(symbol, "okx");
  const legacy = !validSymbols ? true : validSymbols.has(symbol);
  if (reg === "yes") {
    if (validSymbols && !legacy) {
      logDisagreement("okxWs.isOkxSupported", symbol, true, false);
    }
    return true;
  }
  if (reg === "no") {
    if (legacy && validSymbols) {
      logDisagreement("okxWs.isOkxSupported", symbol, false, true);
    }
    return false;
  }
  return legacy;
}

let ws: WebSocket | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
let lastConnectedAt = 0;
let started = false;

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
  logger.info({ exchange: "okx", delay }, "okx-ws: reconnecting");
}

function buildArgs(symbols: string[]): { channel: string; instId: string }[] {
  const args: { channel: string; instId: string }[] = [];
  for (const sym of symbols) {
    const instId = toInstId(sym);
    for (const channel of CHANNELS) {
      args.push({ channel, instId });
    }
  }
  return args;
}

function sendOp(op: "subscribe" | "unsubscribe", symbols: string[]): void {
  if (!ws || !connected) return;
  if (symbols.length === 0) return;
  const args = buildArgs(symbols);
  // OKX accepts up to ~64KB per frame; chunk to be safe.
  const CHUNK = 60;
  for (let i = 0; i < args.length; i += CHUNK) {
    ws.send(JSON.stringify({ op, args: args.slice(i, i + CHUNK) }));
  }
}

export function ensureSubscribed(symbol: string): void {
  if (subscribed.has(symbol)) return;
  if (!isOkxSupported(symbol)) return;
  subscribed.add(symbol);
  if (connected) sendOp("subscribe", [symbol]);
}

function reconcileSubscriptions(): void {
  pruneTouches();
  const targets = new Set(listActive());
  const toRemove: string[] = [];
  for (const s of subscribed) {
    if (!targets.has(s) && !isActive(s)) toRemove.push(s);
  }
  for (const s of toRemove) {
    subscribed.delete(s);
    bookState.delete(toInstId(s));
    okxStore.forget(s);
    forgetTrades(s);
  }
  if (toRemove.length > 0) {
    if (connected) sendOp("unsubscribe", toRemove);
    logger.info(
      { exchange: "okx", count: toRemove.length },
      "okx-ws: evicted idle subscriptions",
    );
  }
}

function applyBookSide(
  side: Map<number, OkxBookLevel>,
  rows: string[][],
): void {
  for (const row of rows) {
    const price = parseFloat(row[0]);
    const size = parseFloat(row[1]);
    if (!Number.isFinite(price)) continue;
    if (size === 0) {
      side.delete(price);
    } else {
      side.set(price, {
        price,
        size,
        numOrders: parseInt(row[3] ?? "1", 10) || 1,
      });
    }
  }
}

function materializeBook(state: BookState): OkxOrderbook {
  const bids = Array.from(state.bids.values()).sort((a, b) => b.price - a.price);
  const asks = Array.from(state.asks.values()).sort((a, b) => a.price - b.price);
  return { bids, asks };
}

interface OkxWsMsg {
  event?: string;
  action?: string;
  arg?: { channel?: string; instId?: string };
  data?: unknown[];
  msg?: string;
  code?: string;
}

function handleMessage(msg: OkxWsMsg): void {
  if (msg.event === "error") {
    logger.warn({ exchange: "okx", code: msg.code, msg: msg.msg }, "okx-ws: error event");
    return;
  }
  if (msg.event === "subscribe" || msg.event === "unsubscribe") return;
  if (msg.event === "channel-conn-count" || msg.event === "channel-conn-count-error") return;

  const arg = msg.arg;
  const data = msg.data;
  if (!arg || !data || !Array.isArray(data) || !arg.channel || !arg.instId) return;
  const symbol = fromInstId(arg.instId);

  if (arg.channel === "tickers") {
    const t = data[0] as OkxTicker | undefined;
    if (t) okxStore.setTicker(symbol, t);
  } else if (arg.channel === "funding-rate") {
    const f = data[0] as { fundingRate?: string; nextFundingRate?: string } | undefined;
    if (f && f.fundingRate !== undefined) {
      okxStore.setFunding(symbol, {
        fundingRate: parseFloat(f.fundingRate),
        nextFundingRate: f.nextFundingRate ? parseFloat(f.nextFundingRate) : null,
      });
    }
  } else if (arg.channel === "open-interest") {
    const o = data[0] as { oi?: string; oiUsd?: string } | undefined;
    if (o && o.oi !== undefined && o.oiUsd !== undefined) {
      okxStore.setOI(symbol, {
        oi: parseFloat(o.oi),
        oiUsd: parseFloat(o.oiUsd),
      });
    }
  } else if (arg.channel === "trades") {
    // Push tape: data is an array of trade prints. OKX side strings are
    // "buy"/"sell" and refer to the taker (aggressor) side, which maps
    // directly to TradeLite "B"/"A".
    for (const row of data as Array<{
      px?: string;
      sz?: string;
      side?: string;
      ts?: string;
    }>) {
      if (!row || row.px === undefined || row.sz === undefined) continue;
      const time = row.ts ? parseInt(row.ts, 10) : Date.now();
      addTrade(symbol, {
        side: row.side === "buy" ? "B" : "A",
        px: row.px,
        sz: row.sz,
        time: Number.isFinite(time) ? time : Date.now(),
      });
    }
  } else if (arg.channel === "books") {
    const action = msg.action;
    const d = data[0] as { bids?: string[][]; asks?: string[][] } | undefined;
    if (!d) return;
    let state = bookState.get(arg.instId);
    if (!state || action === "snapshot") {
      state = { bids: new Map(), asks: new Map() };
      bookState.set(arg.instId, state);
    }
    applyBookSide(state.bids, d.bids ?? []);
    applyBookSide(state.asks, d.asks ?? []);
    okxStore.setBook(symbol, materializeBook(state));
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
  logger.info({ exchange: "okx" }, "okx-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info(
      { exchange: "okx", subscriptions: subscribed.size },
      "okx-ws: connected",
    );
    if (subscribed.size > 0) {
      // Reset book state — OKX sends fresh snapshots on (re)subscribe.
      for (const s of subscribed) bookState.delete(toInstId(s));
      sendOp("subscribe", Array.from(subscribed));
    }
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    if (text === "pong") {
      lastPongAt = Date.now();
      return;
    }
    try {
      const msg = JSON.parse(text);
      handleMessage(msg);
    } catch (err) {
      logger.warn(
        { exchange: "okx", err: String(err), preview: text.slice(0, 200) },
        "okx-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    logger.warn(
      { exchange: "okx", code, reason: reason.toString() },
      "okx-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "okx", err: err.message }, "okx-ws: socket error");
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
        logger.warn({ exchange: "okx" }, "okx-ws: pong timeout, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, 20_000);
}

function startReconcileLoop(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(reconcileSubscriptions, 60_000);
}

export function startOkxWs(): void {
  if (started) return;
  started = true;
  void loadUntilReady();
  // Refresh the universe periodically so newly listed perps become eligible
  // and delisted ones get filtered out without a server restart.
  setInterval(() => void loadValidUniverse(), 60 * 60_000);
  connect();
  startPingLoop();
  startReconcileLoop();
}

// Exchange is "healthy" if the socket is currently connected AND has produced
// a recent pong/message. live.ts uses this to decide whether to trust cached
// data after a long disconnect.
export function isOkxWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastPongAt) return false;
  return Date.now() - lastPongAt < 60_000;
}

export function getOkxWsHealth() {
  return {
    connected,
    healthy: isOkxWsHealthy(),
    subscriptions: subscribed.size,
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
    cache: okxStore.size(),
    oldestTickerAgeMs: okxStore.oldestAgeMs(),
    perSymbolAgesMs: okxStore.perSymbolAges(),
  };
}
