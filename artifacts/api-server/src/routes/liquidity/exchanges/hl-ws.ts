import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { hlStore, listActive, isActive, pruneTouches } from "./ws-store";
import { addTrades, forgetTrades } from "./trades-store";
import { fetchAllAssets, resolveHlCoin, type HlAssetCtx, type HlOrderbook, type HlBookLevel } from "./hyperliquid";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

let validCoins: Set<string> | null = null;

async function ensureValidCoins(): Promise<Set<string>> {
  if (validCoins) return validCoins;
  const all = await fetchAllAssets();
  if (!all) return new Set();
  validCoins = new Set(all.keys());
  logger.info({ exchange: "hl", count: validCoins.size }, "hl-ws: loaded valid coin universe");
  return validCoins;
}

function toSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

const subscribed = new Set<string>();

let ws: WebSocket | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
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
  logger.info({ exchange: "hl", delay }, "hl-ws: reconnecting");
}

function send(payload: unknown): void {
  if (!ws || !connected) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ exchange: "hl", err: String(err) }, "hl-ws: send failed");
  }
}

const subQueue: Array<() => void> = [];
let subPumpRunning = false;

function pumpSubQueue(): void {
  if (subPumpRunning) return;
  subPumpRunning = true;
  const tick = () => {
    if (!connected || subQueue.length === 0) {
      subPumpRunning = false;
      return;
    }
    const next = subQueue.shift();
    if (next) next();
    setTimeout(tick, 30);
  };
  setTimeout(tick, 0);
}

async function sendSubs(method: "subscribe" | "unsubscribe", symbols: string[]): Promise<void> {
  await ensureValidCoins();
  for (const sym of symbols) {
    // Use the case-preserving resolver so kilo-perps ("kPEPE", "kSHIB", …)
    // are subscribed with the exact casing HL's API expects. A naive
    // uppercase ("KPEPE") silently returns nothing.
    const coin = await resolveHlCoin(sym);
    if (!coin) {
      logger.debug({ exchange: "hl", sym }, "hl-ws: skipping unknown coin");
      continue;
    }
    subQueue.push(() => send({ method, subscription: { type: "l2Book", coin } }));
    subQueue.push(() => send({ method, subscription: { type: "activeAssetCtx", coin } }));
    subQueue.push(() => send({ method, subscription: { type: "trades", coin } }));
  }
  pumpSubQueue();
}

export function ensureSubscribed(symbol: string): void {
  if (subscribed.has(symbol)) return;
  subscribed.add(symbol);
  if (connected) void sendSubs("subscribe", [symbol]);
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
    hlStore.forget(s);
    forgetTrades(s);
  }
  if (toRemove.length > 0) {
    if (connected) void sendSubs("unsubscribe", toRemove);
    logger.info(
      { exchange: "hl", count: toRemove.length },
      "hl-ws: evicted idle subscriptions",
    );
  }
}

interface HlWsMsg {
  channel?: string;
  data?: unknown;
}

function handleMessage(msg: HlWsMsg): void {
  if (!msg || !msg.channel) return;
  lastMessageAt = Date.now();
  if (msg.channel === "subscriptionResponse" || msg.channel === "pong") return;

  if (msg.channel === "l2Book") {
    const data = msg.data as
      | {
          coin?: string;
          levels?: { px: string; sz: string; n?: number }[][];
        }
      | undefined;
    if (!data || !data.coin || !Array.isArray(data.levels)) return;
    const parseLevel = (l: { px: string; sz: string; n?: number }): HlBookLevel => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
      numOrders: l.n ?? 1,
    });
    const book: HlOrderbook = {
      bids: (data.levels[0] ?? []).map(parseLevel),
      asks: (data.levels[1] ?? []).map(parseLevel),
    };
    hlStore.setBook(toSymbol(data.coin), book);
  } else if (msg.channel === "trades") {
    // HL trades channel pushes an array of prints. `side` is already "B"/"A"
    // (taker side) so it maps directly to TradeLite.
    const data = msg.data as
      | Array<{ coin?: string; side?: string; px?: string; sz?: string; time?: number }>
      | undefined;
    if (!Array.isArray(data) || data.length === 0) return;
    const bySymbol = new Map<string, Array<{ side: "B" | "A"; px: string; sz: string; time: number }>>();
    for (const row of data) {
      if (!row || !row.coin || row.px === undefined || row.sz === undefined) continue;
      const sym = toSymbol(row.coin);
      let arr = bySymbol.get(sym);
      if (!arr) {
        arr = [];
        bySymbol.set(sym, arr);
      }
      arr.push({
        side: row.side === "B" ? "B" : "A",
        px: row.px,
        sz: row.sz,
        time: typeof row.time === "number" ? row.time : Date.now(),
      });
    }
    for (const [sym, trades] of bySymbol) addTrades(sym, trades);
  } else if (msg.channel === "activeAssetCtx") {
    const data = msg.data as
      | {
          coin?: string;
          ctx?: {
            funding?: string;
            openInterest?: string;
            markPx?: string;
            oraclePx?: string;
            midPx?: string;
            prevDayPx?: string;
            dayNtlVlm?: string;
          };
        }
      | undefined;
    if (!data || !data.coin || !data.ctx) return;
    const ctx = data.ctx;
    const markPx = parseFloat(ctx.markPx ?? "0");
    const asset: HlAssetCtx = {
      coin: data.coin,
      funding: parseFloat(ctx.funding ?? "0"),
      openInterest: parseFloat(ctx.openInterest ?? "0"),
      markPx,
      oraclePx: parseFloat(ctx.oraclePx ?? ctx.markPx ?? "0"),
      midPx: parseFloat(ctx.midPx ?? ctx.markPx ?? "0") || markPx,
      prevDayPx: parseFloat(ctx.prevDayPx ?? "0"),
      dayNtlVlm: parseFloat(ctx.dayNtlVlm ?? "0"),
    };
    hlStore.setAsset(toSymbol(data.coin), asset);
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
  logger.info({ exchange: "hl" }, "hl-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    lastMessageAt = Date.now();
    lastConnectedAt = Date.now();
    logger.info(
      { exchange: "hl", subscriptions: subscribed.size },
      "hl-ws: connected",
    );
    if (subscribed.size > 0) void sendSubs("subscribe", Array.from(subscribed));
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    try {
      const msg = JSON.parse(text);
      handleMessage(msg);
    } catch (err) {
      logger.warn(
        { exchange: "hl", err: String(err), preview: text.slice(0, 200) },
        "hl-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    // Drop any in-flight subscribe/unsubscribe ops queued for the dead socket.
    // On reconnect, the open handler reissues subscribes for the current set.
    subQueue.length = 0;
    subPumpRunning = false;
    logger.warn(
      { exchange: "hl", code, reason: reason.toString() },
      "hl-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "hl", err: err.message }, "hl-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && connected) {
      send({ method: "ping" });
      if (lastMessageAt && Date.now() - lastMessageAt > 60_000) {
        logger.warn({ exchange: "hl" }, "hl-ws: message timeout, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }, 25_000);
}

function startReconcileLoop(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(reconcileSubscriptions, 60_000);
}

export function startHlWs(): void {
  if (started) return;
  started = true;
  connect();
  startPingLoop();
  startReconcileLoop();
}

export function isHlWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastMessageAt) return false;
  return Date.now() - lastMessageAt < 60_000;
}

export function getHlWsHealth() {
  return {
    connected,
    healthy: isHlWsHealthy(),
    subscriptions: subscribed.size,
    reconnectAttempts,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastMessageAgeMs: lastMessageAt ? Date.now() - lastMessageAt : null,
    cache: hlStore.size(),
    oldestAssetAgeMs: hlStore.oldestAgeMs(),
    perSymbolAgesMs: hlStore.perSymbolAges(),
  };
}
