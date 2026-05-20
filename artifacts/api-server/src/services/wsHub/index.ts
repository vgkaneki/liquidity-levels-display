// Single-installation WebSocket broadcaster.
//
// Channels:
//   heatmap:<SYMBOL>   — coalesced heatmap snapshot from current book + ticker
//   depth:<SYMBOL>     — coalesced raw orderbook (bids/asks) from current book
//   trades:<SYMBOL>    — incremental trade prints
//   levels:<SYMBOL>    — full level-registry snapshot whenever it changes
//   scanner:alerts     — scanner alert deltas (T002 will start producing these)
//
// Protocol: client sends `{op:"sub",channel:"…"}` or `{op:"unsub",…}` or
// `{op:"ping"}`. Server replies with one `{type:"snapshot",channel,data}`
// when subscribing, then pushes `{type:"delta",channel,data}` thereafter.
//
// The hub never opens any new exchange connections — it consumes the
// existing `ws-store`/`trades-store` pubsub plus the level registry.

import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../../lib/logger";
import { sessionMiddleware } from "../../app";
import { listActive, touch } from "../../routes/liquidity/exchanges/ws-store";
import {
  subscribeBookUpdates,
  subscribeTickerUpdates,
} from "../../routes/liquidity/exchanges/ws-store";
import { subscribeTradeUpdates } from "../../routes/liquidity/exchanges/trades-store";
import {
  ensureSubscribed as okxSub,
} from "../../routes/liquidity/exchanges/okx-ws";
import { ensureSubscribed as hlSub } from "../../routes/liquidity/exchanges/hl-ws";
import * as toobitWs from "../../routes/liquidity/exchanges/toobit-ws";
import * as live from "../../routes/liquidity/exchanges/live";
import { buildHeatLevels, buildOrderbookLevels } from "../../routes/liquidity/data";
import { levelRegistry } from "../levelRegistry";
import { getRecentTrades } from "../../routes/liquidity/exchanges/trades-store";

interface ChannelClient {
  ws: WebSocket;
  channels: Set<string>;
  lastPong: number;
  // Per-user identity carried over from the session-validated upgrade
  // handshake. All current channels are global market data so we don't
  // filter on this yet, but any future per-user channel (e.g.
  // `alerts:user:<id>`) can gate subscribes against this field.
  userId: string;
}

const clients = new Set<ChannelClient>();
// channel -> set of clients subscribed
const subscribers = new Map<string, Set<ChannelClient>>();

const PING_INTERVAL_MS = 25_000;
const IDLE_TIMEOUT_MS = 60_000;
const COALESCE_MS = 200;

// Pending coalesced sends per channel.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function send(client: ChannelClient, msg: object): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  try {
    client.ws.send(JSON.stringify(msg));
  } catch (e) {
    logger.debug({ err: e }, "ws-hub: send failed");
  }
}

function broadcast(channel: string, msg: object): void {
  const set = subscribers.get(channel);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const c of set) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try { c.ws.send(payload); } catch { /* swallow */ }
  }
}

function scheduleCoalesced(channel: string, build: () => unknown): void {
  if (pending.has(channel)) return;
  const t = setTimeout(() => {
    pending.delete(channel);
    const data = build();
    if (data === undefined) return;
    broadcast(channel, { type: "delta", channel, data });
  }, COALESCE_MS);
  pending.set(channel, t);
}

// --- Channel data builders ---

async function buildHeatmapPayload(symbol: string): Promise<unknown | null> {
  // Two independent layers, two independent source ladders:
  //
  //   * Book / heatmap depth — OKX-first, HL fallback. OKX's L2 channel
  //     is denser and lower-latency on most majors so we keep its lead
  //     for the visual depth shading.
  //   * Live price + 24h rollups — Hyperliquid-first, then Toobit, then
  //     OKX. The candle source ladder is HL→Toobit (OKX is not in the
  //     candle fetch path); keeping HL primary here means the chart's
  //     header price, OHLC strip, axis label, and forming bar agree with
  //     the venue printing the candles. We also bundle funding / OI /
  //     volume / change from the same venue we took the price from, so
  //     the price card is internally consistent (no OKX volume next to
  //     an HL mark price).
  //
  // We kick off the OKX book fetch and the HL ticker bundle in parallel
  // because both are happy-path I/O — only fallback tiers run serially.
  const [okxBook, hlAsset] = await Promise.all([
    live.getOkxOrderbook(symbol),
    live.getHlAsset(symbol),
  ]);
  let book = okxBook;
  let bookExchange: "okx" | "hl" = "okx";
  if (!book) {
    book = await live.getHlOrderbook(symbol);
    bookExchange = "hl";
  }
  if (!book) return null;
  const bids = book.bids.map((l) => [l.price, l.size] as [number, number]);
  const asks = book.asks.map((l) => [l.price, l.size] as [number, number]);

  // --- Price ladder ---
  let mark = NaN;
  let priceSource: "hyperliquid" | "toobit" | "okx" | null = null;
  let priceType: "mark" | "last" = "mark";
  let fundingRate: number | undefined;
  let openInterest: number | undefined;
  let volume24h: number | undefined;
  let priceChange24h: number | undefined;

  // Tier 1 — Hyperliquid: real funding mark + bundled rollups in one call.
  if (hlAsset && hlAsset.markPx > 0) {
    mark = hlAsset.markPx;
    priceSource = "hyperliquid";
    priceType = "mark";
    fundingRate = hlAsset.funding;
    openInterest = hlAsset.openInterest * hlAsset.markPx;
    volume24h = hlAsset.dayNtlVlm;
    if (hlAsset.prevDayPx > 0) {
      priceChange24h = parseFloat(
        (((hlAsset.markPx - hlAsset.prevDayPx) / hlAsset.prevDayPx) * 100).toFixed(2),
      );
    }
  }

  // Tier 2 — Toobit (last-traded price; funding/OI not on the WS feed,
  // so we leave them undefined and let the frontend's REST snapshot
  // continue serving the previous values via the heatmap merge).
  if (!Number.isFinite(mark) || mark <= 0) {
    if (toobitWs.isToobitSupported(symbol)) {
      toobitWs.ensureSubscribed(symbol);
      const t = toobitWs.getToobitTicker(symbol);
      if (t && t.last > 0) {
        mark = t.last;
        priceSource = "toobit";
        priceType = "last";
        if (t.open24h && t.open24h > 0) {
          priceChange24h = parseFloat(
            (((t.last - t.open24h) / t.open24h) * 100).toFixed(2),
          );
        }
        if (typeof t.volume24h === "number") volume24h = t.volume24h * t.last;
      }
    }
  }

  // Tier 3 — OKX (last-traded; full funding/OI/volume slate available).
  if (!Number.isFinite(mark) || mark <= 0) {
    const [ticker, funding, oi] = await Promise.all([
      live.getOkxTicker(symbol),
      live.getOkxFunding(symbol),
      live.getOkxOI(symbol),
    ]);
    if (ticker) {
      const last = parseFloat(ticker.last);
      if (Number.isFinite(last) && last > 0) {
        mark = last;
        priceSource = "okx";
        priceType = "last";
        const open24h = parseFloat(ticker.open24h);
        if (Number.isFinite(open24h) && open24h > 0) {
          priceChange24h = parseFloat((((mark - open24h) / open24h) * 100).toFixed(2));
        }
        const volCcy = parseFloat(ticker.volCcy24h);
        if (Number.isFinite(volCcy)) volume24h = volCcy * mark;
        if (funding?.fundingRate !== undefined) fundingRate = funding.fundingRate;
        if (oi?.oiUsd !== undefined) openInterest = oi.oiUsd;
      }
    }
  }

  // Last-resort: every ticker tier returned empty. Use the top-of-book
  // bid as a synthetic mark just so the heatmap can still be drawn,
  // and tag the price source as the *book* venue (not "hyperliquid")
  // so the UI remains honest about the only live touchpoint we have.
  if (!Number.isFinite(mark) || mark <= 0 || priceSource === null) {
    mark = bids[0]?.[0] ?? 0;
    if (!mark) return null;
    priceSource = bookExchange === "hl" ? "hyperliquid" : "okx";
    priceType = "last";
  }

  const levels = buildHeatLevels(bids, asks, mark, 150);
  // `exchange` keeps its existing meaning (book source). `priceSource`
  // and `priceType` are the new contract that lets the chart UI label
  // the visible price honestly and surface a fallback indicator the
  // moment HL drops out.
  const payload: Record<string, unknown> = {
    symbol,
    exchange: bookExchange,
    priceSource,
    priceType,
    markPrice: mark,
    indexPrice: mark,
    levels,
    updatedAt: new Date().toISOString(),
  };
  if (fundingRate !== undefined) payload.fundingRate = fundingRate;
  if (openInterest !== undefined) payload.openInterest = openInterest;
  if (volume24h !== undefined) payload.volume24h = volume24h;
  if (priceChange24h !== undefined) payload.priceChange24h = priceChange24h;
  return payload;
}

async function buildDepthPayload(symbol: string): Promise<unknown | null> {
  // Source preference: okx > hyperliquid > toobit. The first source that
  // has a current book wins; the rest are silent fallbacks.
  let exchange: "okx" | "hyperliquid" | "toobit" = "okx";
  let bidsRaw: [number, number][] | null = null;
  let asksRaw: [number, number][] | null = null;

  const okx = await live.getOkxOrderbook(symbol);
  if (okx && okx.bids.length > 0) {
    bidsRaw = okx.bids.map((l) => [l.price, l.size]);
    asksRaw = okx.asks.map((l) => [l.price, l.size]);
  } else {
    const hl = await live.getHlOrderbook(symbol);
    if (hl && hl.bids.length > 0) {
      exchange = "hyperliquid";
      bidsRaw = hl.bids.map((l) => [l.price, l.size]);
      asksRaw = hl.asks.map((l) => [l.price, l.size]);
    } else {
      // Toobit returns native [price,size] tuples directly.
      const tb = toobitWs.getToobitBook(symbol);
      if (tb && tb.bids.length > 0) {
        exchange = "toobit";
        bidsRaw = tb.bids;
        asksRaw = tb.asks;
      }
    }
  }

  if (!bidsRaw || !asksRaw) return null;
  const bids = buildOrderbookLevels(bidsRaw);
  const asks = buildOrderbookLevels(asksRaw);
  return {
    symbol,
    exchange,
    bids,
    asks,
    updatedAt: new Date().toISOString(),
  };
}

function buildLevelsPayload(symbol: string): unknown {
  return {
    symbol,
    levels: levelRegistry.getLevels(symbol),
    updatedAt: new Date().toISOString(),
  };
}

// --- Market overview channel: a single broadcast to all subscribers ---
//
// MarketOverview used to repoll /api/liquidity/market-overview every 30s. We
// migrate it to the same WS backbone so the page lights up within ~5s of any
// real change while only paying for one rollup compute per interval (not
// per-tab). The payload shape is intentionally identical to the REST
// endpoint so the frontend renderer is unchanged.

let marketOverviewLatest: unknown = null;
let marketOverviewTimer: NodeJS.Timeout | null = null;
// Slow safety-net cadence only — the actual broadcast cadence is driven
// by exchange-tick events through `scheduleMarketOverviewRebuild`.
const MARKET_OVERVIEW_INTERVAL_MS = Math.max(30_000, Number(process.env.MARKET_OVERVIEW_WS_INTERVAL_MS ?? "60000") || 60_000);
const MARKET_OVERVIEW_REBUILD_MIN_MS = Math.max(10_000, Number(process.env.MARKET_OVERVIEW_REBUILD_MIN_MS ?? "20000") || 20_000);
let marketOverviewLastRebuildAt = 0;

async function buildMarketOverviewPayload(): Promise<unknown | null> {
  // Lazy import — the route file owns the heavy okx/hl SDK init and we want
  // the hub module to stay light. Importing here is a one-time cost.
  // Use the cached/single-flight wrapper so the WS broadcast tick and the
  // REST `/api/liquidity/market-overview` route share one in-flight compute
  // instead of duplicating the 1.8–9s walk every 30s.
  const { getMarketOverviewCached } = await import("../marketOverview");
  return getMarketOverviewCached();
}

function startMarketOverviewLoop(): void {
  if (marketOverviewTimer) return;
  const tick = async (): Promise<void> => {
    try {
      const next = await buildMarketOverviewPayload();
      if (next) {
        marketOverviewLatest = next;
        broadcast("market:overview", {
          type: "delta",
          channel: "market:overview",
          data: next,
        });
      }
    } catch (e) {
      logger.warn({ err: e }, "ws-hub: market overview tick failed");
    }
  };
  // Prime once on first subscribe so a fresh client sees data quickly.
  void tick();
  // The actual update cadence is now driven by upstream exchange-tick
  // events (see wireUpstream below) coalesced to ~250ms. The interval
  // here is a slow safety-net rebuild every 30s in case the exchange WS
  // is silent (e.g. weekend dead-quiet markets) so the rollup doesn't
  // stale forever.
  marketOverviewTimer = setInterval(() => void tick(), MARKET_OVERVIEW_INTERVAL_MS);
  marketOverviewTimer.unref?.();
}

// Recompute + broadcast market overview, coalesced. Exposed so the
// upstream ticker-event wiring can fire it on real ticks. We can't reuse
// `scheduleCoalesced` because the rollup builder is async; this wraps
// our own pending-flag debounce keyed to the channel.
let marketOverviewPending = false;
function scheduleMarketOverviewRebuild(): void {
  if (!subscribers.has("market:overview")) return;
  const now = Date.now();
  if (now - marketOverviewLastRebuildAt < MARKET_OVERVIEW_REBUILD_MIN_MS) return;
  if (marketOverviewPending) return;
  marketOverviewLastRebuildAt = now;
  marketOverviewPending = true;
  setTimeout(() => {
    marketOverviewPending = false;
    void (async () => {
      try {
        const next = await buildMarketOverviewPayload();
        if (!next) return;
        marketOverviewLatest = next;
        broadcast("market:overview", {
          type: "delta",
          channel: "market:overview",
          data: next,
        });
      } catch (e) {
        logger.warn({ err: e }, "ws-hub: market overview rebuild failed");
      }
    })();
  }, COALESCE_MS);
}

function buildTradesSnapshot(symbol: string): unknown {
  return {
    symbol,
    trades: getRecentTrades(symbol, 60_000),
    updatedAt: new Date().toISOString(),
  };
}

// --- Scanner alerts: producer-side hooks ---
//
// The scanner alert engine itself lives in T002; this hub only owns the
// transport. We expose `publishScannerAlert(alert)` so when the engine
// lands it can fan out alerts to every subscribed client without
// re-implementing the protocol. Until then the snapshot is empty and
// no deltas are produced — the channel is wired and will start
// streaming the moment the engine calls `publishScannerAlert`.

interface ScannerAlert {
  id: string;
  // The owning user's id. The WS hub only delivers an alert to
  // sockets whose authenticated `client.userId` matches this field —
  // every other subscriber on `scanner:alerts` skips it. This is the
  // delivery-side enforcement of the per-user alert boundary.
  userId: string;
  symbol: string;
  kind: string;
  message: string;
  ts: number;
}

const recentAlerts: ScannerAlert[] = [];
const ALERT_BUFFER = 50;

function scannerAlertSnapshot(userId: string): unknown {
  // The recent-alerts ring buffer is process-global, but the snapshot
  // we hand back to a freshly-subscribed socket is filtered to that
  // user's own alerts only. This means a user opening the app sees
  // their own recent history without ever being shown another user's.
  const own = recentAlerts.filter((a) => a.userId === userId);
  return {
    alerts: own.slice(-ALERT_BUFFER),
    updatedAt: new Date().toISOString(),
  };
}

export function publishScannerAlert(alert: ScannerAlert): void {
  recentAlerts.push(alert);
  if (recentAlerts.length > ALERT_BUFFER * 2) {
    recentAlerts.splice(0, recentAlerts.length - ALERT_BUFFER);
  }
  // Per-user fan-out: never send the alert to a socket owned by a
  // different user, even if they're also subscribed to `scanner:alerts`.
  // Anonymous (or otherwise unowned) alerts are dropped on the floor —
  // there is no anonymous WS so there is no recipient anyway.
  if (!alert.userId) return;
  const set = subscribers.get("scanner:alerts");
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({
    type: "delta",
    channel: "scanner:alerts",
    data: { alert, updatedAt: new Date().toISOString() },
  });
  for (const c of set) {
    if (c.userId !== alert.userId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try { c.ws.send(payload); } catch { /* swallow */ }
  }
}

// --- Subscription handling ---

type SymbolChannelKind = "heatmap" | "depth" | "trades" | "levels";
type GlobalChannelKind = "scanner:alerts" | "market:overview";
type ParsedChannel =
  | { kind: SymbolChannelKind; symbol: string }
  | { kind: GlobalChannelKind };

const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "heatmap",
  "depth",
  "trades",
  "levels",
]);

// Whitelist parser. Anything not on the v1 channel list is rejected so a
// client can't accidentally subscribe to a typo and silently get no
// updates (or pin a server-side subscriber slot for nothing).
function parseChannel(channel: string): ParsedChannel | null {
  if (channel === "scanner:alerts") return { kind: "scanner:alerts" };
  if (channel === "market:overview") return { kind: "market:overview" };
  const m = /^([a-z]+):([A-Z0-9-]+)$/.exec(channel);
  if (!m) return null;
  const kind = m[1]!;
  if (!SYMBOL_KINDS.has(kind)) return null;
  return {
    kind: kind as SymbolChannelKind,
    symbol: m[2]!.replace(/-/g, "").toUpperCase(),
  };
}

function canonicalChannel(parsed: ParsedChannel): string {
  if (parsed.kind === "scanner:alerts") return "scanner:alerts";
  if (parsed.kind === "market:overview") return "market:overview";
  return `${parsed.kind}:${parsed.symbol}`;
}

async function handleSubscribe(client: ChannelClient, rawChannel: string): Promise<void> {
  const parsed = parseChannel(rawChannel);
  if (!parsed) {
    send(client, { type: "error", channel: rawChannel, message: "invalid channel" });
    return;
  }
  // Always store the canonical channel name (e.g. `heatmap:BTCUSDT`) so
  // upstream emitters that use the canonical symbol don't miss
  // subscribers who subscribed via a dashed alias.
  const channel = canonicalChannel(parsed);
  if (client.channels.has(channel)) return;

  if ("symbol" in parsed) {
    touch(parsed.symbol);
    okxSub(parsed.symbol);
    hlSub(parsed.symbol);
    toobitWs.ensureSubscribed(parsed.symbol);
  }

  // Build snapshot first, send it, then register the subscriber. This
  // guarantees the client always sees a snapshot before any deltas
  // (otherwise an upstream tick during the await could broadcast a delta
  // before the snapshot arrives, which the merge-on-client logic does
  // not tolerate).
  let snapshot: unknown = null;
  try {
    if (parsed.kind === "heatmap") {
      snapshot = await buildHeatmapPayload(parsed.symbol);
    } else if (parsed.kind === "depth") {
      snapshot = await buildDepthPayload(parsed.symbol);
    } else if (parsed.kind === "trades") {
      snapshot = buildTradesSnapshot(parsed.symbol);
    } else if (parsed.kind === "levels") {
      snapshot = buildLevelsPayload(parsed.symbol);
    } else if (parsed.kind === "scanner:alerts") {
      snapshot = scannerAlertSnapshot(client.userId);
    } else if (parsed.kind === "market:overview") {
      // Lazy-init the broadcast loop on first subscribe so we don't pay for
      // the rollup compute when nobody's watching MarketOverview.
      startMarketOverviewLoop();
      if (marketOverviewLatest) {
        snapshot = marketOverviewLatest;
      } else {
        snapshot = await buildMarketOverviewPayload();
        if (snapshot) marketOverviewLatest = snapshot;
      }
    }
  } catch (e) {
    logger.warn({ err: e, channel }, "ws-hub: snapshot build failed");
  }
  // Echo the canonical channel back so the client's subscribe is keyed
  // consistently with subsequent deltas.
  send(client, { type: "snapshot", channel, data: snapshot });

  // Now register so deltas start flowing.
  client.channels.add(channel);
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(client);
}

function handleUnsubscribe(client: ChannelClient, channel: string): void {
  if (!client.channels.has(channel)) return;
  client.channels.delete(channel);
  const set = subscribers.get(channel);
  if (set) {
    set.delete(client);
    if (set.size === 0) subscribers.delete(channel);
  }
}

// --- Wiring upstream sources to channels ---

function wireUpstream(): void {
  subscribeBookUpdates((_exchange, symbol) => {
    const heat = `heatmap:${symbol}`;
    const depth = `depth:${symbol}`;
    if (subscribers.has(heat)) {
      scheduleCoalesced(heat, () => buildHeatmapPayloadSync(symbol));
    }
    if (subscribers.has(depth)) {
      scheduleCoalesced(depth, () => buildDepthPayloadSync(symbol));
    }
  });
  subscribeTickerUpdates((_exchange, symbol) => {
    const heat = `heatmap:${symbol}`;
    if (subscribers.has(heat)) {
      scheduleCoalesced(heat, () => buildHeatmapPayloadSync(symbol));
    }
    // Any real exchange tick is a signal that the cross-symbol rollup
    // (top movers / volume / dominance) may have shifted, so rebuild the
    // market overview channel. The function self-debounces and only
    // does work when there are actual subscribers.
    scheduleMarketOverviewRebuild();
  });
  subscribeBookUpdates((_exchange, symbol) => {
    // latencyCleanupV2: book ticks are too frequent for the heavy market
    // overview aggregate. Ticker events and the slow safety-net interval are
    // enough; do not let book churn compete with the focused chart.
    void symbol;
  });
  subscribeTradeUpdates((symbol, trades) => {
    const ch = `trades:${symbol}`;
    if (!subscribers.has(ch)) return;
    // Trades go through immediately — they are already discrete events.
    broadcast(ch, {
      type: "delta",
      channel: ch,
      data: { symbol, trades, updatedAt: new Date().toISOString() },
    });
  });
  levelRegistry.onUpdate((symbol, levels) => {
    const ch = `levels:${symbol}`;
    if (!subscribers.has(ch)) return;
    broadcast(ch, {
      type: "delta",
      channel: ch,
      data: { symbol, levels, updatedAt: new Date().toISOString() },
    });
  });
}

// Sync builder variants: pull from the in-process ws-store maps without
// triggering bootstrap REST. The hub fires these on book/ticker push so by
// definition the data is hot.
function buildHeatmapPayloadSync(symbol: string): unknown | undefined {
  // Fire-and-forget the async builder if no sync data exists. Callers
  // ignore undefined and the next tick will catch up.
  const p = buildHeatmapPayload(symbol);
  // Return a thenable-shaped fallback by blocking on the cached path is
  // not possible synchronously; we return undefined and let the next
  // exchange tick trigger another coalesced rebuild. To avoid losing
  // updates we kick the async build now and broadcast its result.
  p.then((data) => {
    if (!data) return;
    broadcast(`heatmap:${symbol}`, { type: "delta", channel: `heatmap:${symbol}`, data });
  }).catch(() => {});
  return undefined;
}

function buildDepthPayloadSync(symbol: string): unknown | undefined {
  buildDepthPayload(symbol)
    .then((data) => {
      if (!data) return;
      broadcast(`depth:${symbol}`, { type: "delta", channel: `depth:${symbol}`, data });
    })
    .catch(() => {});
  return undefined;
}

// --- Connection handling ---

// Run express-session against the upgrade request so we can read
// `req.session.userId` BEFORE accepting the WebSocket. Express-session
// expects a (req, res, next) triple — we hand it a minimal stub
// response that swallows writes, since we never actually write an HTTP
// response on the upgrade socket from within session middleware.
//
// Returns the session userId or null if no valid session is attached
// to the cookie. We reject the upgrade in the latter case rather than
// allowing an anonymous WS that the engine then has no identity to
// attribute traffic to.
function authenticateUpgrade(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const stubRes = {
      setHeader() { /* noop */ },
      getHeader() { return undefined; },
      writeHead() { return this; },
      end() { /* noop */ },
      on() { return this; },
    } as unknown as ServerResponse;
    try {
      sessionMiddleware(req as unknown as Parameters<typeof sessionMiddleware>[0], stubRes, () => {
        const session = (req as unknown as { session?: { userId?: string } }).session;
        if (session?.userId && typeof session.userId === "string") {
          resolve(session.userId);
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      logger.warn({ err: e }, "ws-hub: session middleware threw on upgrade");
      resolve(null);
    }
  });
}

export function startWsHub(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws")) return;
    void (async () => {
      const userId = await authenticateUpgrade(req);
      if (!userId) {
        // Reject the upgrade with an HTTP 401 and tear down the socket.
        // Browsers treat this as a connection failure and the client's
        // reconnect logic will only succeed once /api/auth/login has
        // (re)established a valid session.
        try {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n\r\n",
          );
        } catch { /* socket may already be torn down */ }
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Stash the userId on the request for the connection handler.
        (req as unknown as { __wsUserId?: string }).__wsUserId = userId;
        wss.emit("connection", ws, req);
      });
    })();
  });

  wss.on("connection", (ws, req) => {
    const userId = (req as unknown as { __wsUserId?: string }).__wsUserId ?? "";
    if (!userId) {
      // Defense-in-depth: handleUpgrade should never run without a
      // userId thanks to the gate above, but if a future refactor
      // breaks that path we close the socket immediately rather than
      // accepting an unauthenticated client.
      try { ws.close(1008, "unauthorized"); } catch { /* swallow */ }
      return;
    }
    const client: ChannelClient = {
      ws,
      channels: new Set(),
      lastPong: Date.now(),
      userId,
    };
    clients.add(client);

    ws.on("message", (raw) => {
      let msg: { op?: string; channel?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === "ping") {
        send(client, { type: "pong", t: Date.now() });
        return;
      }
      if (msg.op === "sub" && typeof msg.channel === "string") {
        void handleSubscribe(client, msg.channel);
        return;
      }
      if (msg.op === "unsub" && typeof msg.channel === "string") {
        handleUnsubscribe(client, msg.channel);
        return;
      }
    });

    ws.on("pong", () => {
      client.lastPong = Date.now();
    });

    ws.on("close", () => {
      for (const ch of client.channels) handleUnsubscribe(client, ch);
      clients.delete(client);
    });

    send(client, { type: "hello", t: Date.now() });
  });

  // Heartbeat + idle eviction.
  setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (now - c.lastPong > IDLE_TIMEOUT_MS) {
        try { c.ws.terminate(); } catch { /* swallow */ }
        continue;
      }
      try { c.ws.ping(); } catch { /* swallow */ }
    }
  }, PING_INTERVAL_MS);

  // Active-subscription touch refresh. The exchange ws-store evicts a
  // symbol from the active set after ACTIVE_TTL_MS (5min) without a
  // touch. Without this loop, a long-lived subscriber that never causes
  // a fresh REST call could see its symbol silently age out and stop
  // receiving deltas. We re-touch every active symbol channel every 60s.
  setInterval(() => {
    for (const channel of subscribers.keys()) {
      const colon = channel.indexOf(":");
      if (colon < 0) continue;
      const kind = channel.slice(0, colon);
      const tail = channel.slice(colon + 1);
      // Skip global channels (scanner:alerts, market:overview).
      if (!SYMBOL_KINDS.has(kind)) continue;
      try { touch(tail); } catch { /* swallow */ }
    }
  }, 60_000);

  wireUpstream();
  logger.info({ activeAtBoot: listActive().length }, "ws-hub: started");
}

export function wsHubStats(): { clients: number; channels: number } {
  return { clients: clients.size, channels: subscribers.size };
}
