// Hyperliquid public liquidation feed.
//
// Hyperliquid does not (yet) expose a fully public market-wide liquidation
// channel — `userEvents` carries `liquidation` rows but is per-wallet, and
// the public `trades` channel does not tag liquidations natively.
//
// To still give callers a real, mergeable HL feed we subscribe to the
// public `trades` stream for the active symbol set and apply a configurable
// detection mode:
//
//   HL_LIQ_DETECT_MODE=off            (default) — connect, but store nothing.
//                                     The merge layer treats HL as silent.
//   HL_LIQ_DETECT_MODE=size           — flag trades whose notional exceeds
//                                     HL_LIQ_SIZE_USD (default 250_000).
//                                     Heuristic, but conservative enough to
//                                     surface the largest forced fills.
//
// "off" is the production-safe default: no false positives, just an
// architecturally complete second source ready to light up if/when HL
// publishes a real liquidation flag (we'd parse it from the trade row).

import WebSocket from "ws";
import { logger } from "../../../lib/logger";
import { listActive, isActive } from "./ws-store";
import { enqueueLiquidation } from "../../../services/liquidationHistory/persistence";

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const RETAIN_MS = 30 * 60_000;
const MAX_PER_SYMBOL = 500;
const ABSOLUTE_MAX_SYMBOLS = Math.max(128, Number(process.env.LIQ_EVENTS_MAX_SYMBOLS ?? "1200") || 1200);
const ACROSS_SYMBOL_LIMIT = Math.max(25, Number(process.env.LIQ_EVENTS_ACROSS_SYMBOL_LIMIT ?? "120") || 120);
const ACROSS_RESULT_LIMIT = Math.max(10, Number(process.env.LIQ_EVENTS_ACROSS_RESULT_LIMIT ?? "250") || 250);

const DETECT_MODE = (process.env.HL_LIQ_DETECT_MODE ?? "off").toLowerCase();
const SIZE_USD_THRESHOLD = (() => {
  const v = Number(process.env.HL_LIQ_SIZE_USD ?? "250000");
  return Number.isFinite(v) && v > 0 ? v : 250_000;
})();

export interface HlLiquidationEvent {
  id: string;
  symbol: string;
  side: "long" | "short";
  price: number;
  size: number;
  usdValue: number;
  timestamp: string;
  ts: number;
  exchange: "hyperliquid";
}

const events = new Map<string, HlLiquidationEvent[]>();

// liqStoreBoundedAcrossV1: bound symbol keys and avoid full gather+sort for
// across-symbol snapshots. Display/storage only; does not affect engines.
function pruneEventArray(symbol: string, arr: HlLiquidationEvent[], cutoff = Date.now() - RETAIN_MS): void {
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

function pushNewestBounded(out: HlLiquidationEvent[], ev: HlLiquidationEvent, limit: number): void {
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

function toSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}
function toCoin(sym: string): string {
  return sym.replace(/USDT$/, "");
}

function pushEvent(ev: HlLiquidationEvent): void {
  let arr = events.get(ev.symbol);
  if (!arr) {
    arr = [];
    events.set(ev.symbol, arr);
  }
  arr.push(ev);
  // Mirror to the persistent log; see okx-liq-ws.ts for rationale.
  enqueueLiquidation({
    id: ev.id,
    exchange: "hyperliquid",
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

export function getHlLiquidations(symbol: string, limit: number): HlLiquidationEvent[] {
  const arr = events.get(symbol);
  if (!arr || arr.length === 0) return [];
  pruneEventArray(symbol, arr);
  const fresh = events.get(symbol);
  if (!fresh || fresh.length === 0) return [];
  return fresh.slice(-limit).reverse();
}

export function getRecentHlLiquidationsAcross(
  symbols: string[],
  limit: number,
): HlLiquidationEvent[] {
  const cappedLimit = Math.max(0, Math.min(ACROSS_RESULT_LIMIT, Math.floor(limit)));
  if (cappedLimit <= 0) return [];
  const cutoff = Date.now() - RETAIN_MS;
  const merged: HlLiquidationEvent[] = [];
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

interface HlTradeRow {
  coin?: string;
  side?: string; // "B" buy / "A" sell on HL
  px?: string;
  sz?: string;
  time?: number;
  tid?: number;
  hash?: string;
  // Future-proof: if HL adds a flag, we pick it up automatically.
  liquidation?: boolean;
}
interface HlWsMsg {
  channel?: string;
  data?: unknown;
}

function classifySide(s: string): "long" | "short" | null {
  const v = s.toUpperCase();
  // On HL the trade `side` is the *taker* side. A taker SELL closing into bids
  // means longs were forced out; a taker BUY into asks means shorts were
  // forced out. Same convention as inferSide() in okx-liq-ws.
  if (v === "A" || v === "S" || v === "SELL") return "long";
  if (v === "B" || v === "BUY") return "short";
  return null;
}

function handleTrade(row: HlTradeRow): void {
  if (!row.coin || !row.side || !row.px || !row.sz || !row.time) return;
  const symbol = toSymbol(row.coin);
  if (!isActive(symbol)) return; // only retain symbols the app cares about

  const price = parseFloat(row.px);
  const size = parseFloat(row.sz);
  if (!Number.isFinite(price) || !Number.isFinite(size)) return;
  const usdValue = price * size;

  let isLiq = row.liquidation === true; // future-proof
  if (!isLiq) {
    if (DETECT_MODE === "off") return;
    if (DETECT_MODE === "size" && usdValue >= SIZE_USD_THRESHOLD) {
      isLiq = true;
    }
  }
  if (!isLiq) return;

  const side = classifySide(row.side);
  if (!side) return;

  const ts = row.time;
  pushEvent({
    id: `hl-${row.coin}-${row.tid ?? ts}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    price,
    size,
    usdValue,
    timestamp: new Date(ts).toISOString(),
    ts,
    exchange: "hyperliquid",
  });
}

let ws: WebSocket | null = null;
let connected = false;
let started = false;
let reconnectAttempts = 0;
let stableTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
let lastConnectedAt = 0;
let lastEventAt = 0;
let totalEvents = 0;
const subscribed = new Set<string>();

// --- Reconnect-storm circuit breaker ---
//
// Even with the 150 ms sub-drip and "don't reset attempts on connect" guard,
// a sustained HL edge issue (e.g. they tighten the IP-level WS rate-limit
// or have an outage) used to manifest as a tight reconnect/close cycle:
// connect → drip 30 subs over 4.5 s → close (1006) → backoff capped at 30 s
// → repeat. The 30 s cap is correct for transient recovery but inappropriate
// during a real upstream incident, and 24 cycles in 10 min was the observed
// pattern before mitigations.
//
// The breaker tracks consecutive "short-lived" connects (socket lifetime
// < SHORT_LIFE_MS). After STORM_THRESHOLD such cycles, the next reconnect
// uses STORM_COOLDOWN_MS instead of normal exponential backoff. One
// successful long-lived connect (>= SHORT_LIFE_MS) clears the counter.
// This bounds our load on HL during outages and self-heals as soon as
// the upstream stabilizes.
const SHORT_LIFE_MS = 10_000;
const STORM_THRESHOLD = 5;
const STORM_COOLDOWN_MS = 5 * 60_000;
let consecutiveShortLives = 0;
let inStormCooldown = false;

function backoffMs(): number {
  const base = inStormCooldown ? STORM_COOLDOWN_MS : Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));
  const jitter = Math.floor(Math.random() * Math.min(5_000, Math.max(250, base * 0.1)));
  return base + jitter;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Cooldown is one-shot — after we wait it out, we go back to normal
    // exponential backoff. If the storm re-triggers, the threshold check
    // re-arms the cooldown.
    inStormCooldown = false;
    connect();
  }, delay);
  logger.info(
    { exchange: "hl-liq", delay, inStormCooldown, consecutiveShortLives },
    "hl-liq-ws: reconnecting",
  );
}

function send(payload: unknown): void {
  if (!ws || !connected) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ exchange: "hl-liq", err: String(err) }, "hl-liq-ws: send error");
  }
}

// Throttled outbound queue. HL closes the socket (code 1006) if a fresh
// connection sends ~25 subscribe frames in a tight burst. The previous
// 50ms drip was *still* fast enough to trip that limit on warm caches with
// 25+ active symbols (25 × 50ms = 1250ms of subscribe traffic, observed to
// close ~1s after every connect). Bumped to 150ms — slower than HL's
// observed cliff while still fully populating subscriptions inside ~5s
// for a typical 30-symbol working set.
const SUB_DRIP_MS = 150;
const SUB_QUEUE_MAX = Math.max(50, Number(process.env.HL_LIQ_SUB_QUEUE_MAX ?? "250") || 250);
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
    setTimeout(tick, SUB_DRIP_MS);
  };
  tick();
}

function queueSubOp(key: string, op: () => void): void {
  if (queuedSubOps.has(key)) return;
  if (subQueue.length >= SUB_QUEUE_MAX) {
    logger.warn({ exchange: "hl-liq", queued: subQueue.length, max: SUB_QUEUE_MAX }, "hl-liq-ws: subscription queue full");
    return;
  }
  queuedSubOps.add(key);
  subQueue.push(() => {
    queuedSubOps.delete(key);
    op();
  });
  pumpSubQueue();
}
function subscribeCoin(coin: string): void {
  queueSubOp(`sub:${coin}`, () => send({ method: "subscribe", subscription: { type: "trades", coin } }));
}
function unsubscribeCoin(coin: string): void {
  queueSubOp(`unsub:${coin}`, () => send({ method: "unsubscribe", subscription: { type: "trades", coin } }));
}

function reconcileSubs(): void {
  const targets = new Set(listActive().map(toCoin));
  for (const coin of subscribed) {
    if (!targets.has(coin)) {
      subscribed.delete(coin);
      if (connected) unsubscribeCoin(coin);
    }
  }
  for (const coin of targets) {
    if (!subscribed.has(coin)) {
      subscribed.add(coin);
      if (connected) subscribeCoin(coin);
    }
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
  logger.info({ exchange: "hl-liq", detectMode: DETECT_MODE }, "hl-liq-ws: connecting");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    // Do NOT reset reconnectAttempts here. HL has been closing fresh sockets
    // within ~150ms (likely a soft IP rate-limit on the WS edge), and a reset
    // here pinned the backoff at the 1s floor forever. Instead we mark the
    // socket healthy after it has stayed up long enough to actually carry
    // data, and only then reset the counter.
    lastPongAt = Date.now();
    lastConnectedAt = Date.now();
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (connected && lastConnectedAt && Date.now() - lastConnectedAt >= 30_000) {
        // Sustained healthy connection — clear both the exponential
        // backoff counter AND the storm-cooldown counter so we recover
        // from a transient incident as soon as HL stabilizes.
        reconnectAttempts = 0;
        consecutiveShortLives = 0;
      }
    }, 30_000);
    stableTimer.unref();
    logger.info({ exchange: "hl-liq" }, "hl-liq-ws: connected");
    // On reconnect, replay subscriptions for any coins we already track,
    // then merge in any newly active symbols. Both paths go through the
    // throttled queue so HL doesn't drop us for spammy subscribe bursts.
    for (const c of subscribed) {
      subQueue.push(() => send({ method: "subscribe", subscription: { type: "trades", coin: c } }));
    }
    pumpSubQueue();
    reconcileSubs();
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    if (text === "pong") {
      lastPongAt = Date.now();
      return;
    }
    try {
      const msg = JSON.parse(text) as HlWsMsg;
      if (!msg || !msg.channel) return;
      lastPongAt = Date.now(); // any inbound counts as liveness
      if (msg.channel === "subscriptionResponse" || msg.channel === "pong") return;
      if (msg.channel !== "trades") return;
      const before = totalEvents;
      const data = msg.data as HlTradeRow[] | undefined;
      if (!Array.isArray(data)) return;
      for (const row of data) handleTrade(row);
      // Best-effort event count for health
      totalEvents += data.length;
      if (totalEvents !== before) lastEventAt = Date.now();
    } catch (err) {
      logger.warn(
        { exchange: "hl-liq", err: String(err), preview: text.slice(0, 200) },
        "hl-liq-ws: parse error",
      );
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    // Track short-lived connections to detect a reconnect storm. If the
    // socket closed in under SHORT_LIFE_MS we count it; once we hit
    // STORM_THRESHOLD in a row, the next reconnect uses a long cooldown
    // (see scheduleReconnect / backoffMs) instead of hammering HL.
    const lifetimeMs = lastConnectedAt ? Date.now() - lastConnectedAt : 0;
    if (lastConnectedAt && lifetimeMs < SHORT_LIFE_MS) {
      consecutiveShortLives++;
      if (consecutiveShortLives >= STORM_THRESHOLD && !inStormCooldown) {
        inStormCooldown = true;
        logger.warn(
          {
            exchange: "hl-liq",
            consecutiveShortLives,
            threshold: STORM_THRESHOLD,
            cooldownMs: STORM_COOLDOWN_MS,
          },
          "hl-liq-ws: reconnect storm detected — entering long cooldown",
        );
      }
    } else if (lifetimeMs >= SHORT_LIFE_MS) {
      // Any long-lived connection clears the storm counter immediately —
      // even a single healthy connect proves HL is responsive again.
      consecutiveShortLives = 0;
    }
    logger.warn(
      { exchange: "hl-liq", code, reason: reason.toString(), lifetimeMs, consecutiveShortLives },
      "hl-liq-ws: closed",
    );
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.warn({ exchange: "hl-liq", err: err.message }, "hl-liq-ws: socket error");
  });
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && connected) {
      try {
        ws.send(JSON.stringify({ method: "ping" }));
      } catch {
        // ignore
      }
      if (lastPongAt && Date.now() - lastPongAt > 60_000) {
        logger.warn({ exchange: "hl-liq" }, "hl-liq-ws: pong timeout, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
      // Stale-feed watchdog: if we're connected, have active subscriptions,
      // and detect mode is on (so events ARE expected), but no event has
      // arrived in 10 min, the socket is probably silently broken
      // (TCP RST not delivered, NAT rebinding, edge dropping data). Force
      // a one-shot terminate; the close handler reconnects with backoff
      // and the storm breaker handles repeat failures.
      // Suppressed entirely when DETECT_MODE=off because in that mode the
      // WS shouldn't even be running, and even in low-volume modes we
      // don't want to flap on a genuinely quiet feed.
      if (
        DETECT_MODE !== "off" &&
        subscribed.size > 0 &&
        lastEventAt &&
        Date.now() - lastEventAt > 10 * 60_000
      ) {
        logger.warn(
          {
            exchange: "hl-liq",
            lastEventAgeMs: Date.now() - lastEventAt,
            subscribedCoins: subscribed.size,
          },
          "hl-liq-ws: stale feed (no events in 10min) — forcing reconnect",
        );
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

export function startHlLiqWs(): void {
  if (started) return;
  started = true;
  // When detect mode is "off" (the production-safe default) we receive
  // every trade row, parse it, then drop it because the merge layer treats
  // HL as silent. That round-trip costs nothing functional but spends a
  // real WS budget — and HL was closing our fresh sockets ~1s after every
  // connect, putting the feed into a permanent reconnect storm (24
  // close/connect cycles in 10 min observed). When detect mode is off
  // there's no upside to staying connected, so we no-op the bring-up
  // entirely. Health endpoint will honestly report `connected: false,
  // detectMode: "off"`. Setting `HL_LIQ_DETECT_MODE=size` (or any future
  // mode) re-enables the WS automatically on the next boot.
  if (DETECT_MODE === "off") {
    logger.info(
      { exchange: "hl-liq", detectMode: DETECT_MODE },
      "hl-liq-ws: skipped (detect mode off — no functional consumer)",
    );
    return;
  }
  connect();
  startPingLoop();
}

export function isHlLiqWsHealthy(): boolean {
  if (!connected) return false;
  if (!lastPongAt) return false;
  return Date.now() - lastPongAt < 60_000;
}

export function getHlLiqWsHealth() {
  return {
    connected,
    healthy: isHlLiqWsHealthy(),
    detectMode: DETECT_MODE,
    sizeUsdThreshold: DETECT_MODE === "size" ? SIZE_USD_THRESHOLD : null,
    reconnectAttempts,
    consecutiveShortLives,
    inStormCooldown,
    connectedAgeMs: lastConnectedAt ? Date.now() - lastConnectedAt : null,
    lastPongAgeMs: lastPongAt ? Date.now() - lastPongAt : null,
    lastEventAgeMs: lastEventAt ? Date.now() - lastEventAt : null,
    symbolsWithEvents: events.size,
    subscribedCoins: subscribed.size,
    totalEvents,
  };
}
