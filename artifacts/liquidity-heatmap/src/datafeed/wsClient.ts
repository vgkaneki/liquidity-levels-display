// Phase 3 — Internal datafeed WS multiplexer.
//
// Owns ONE shared websocket to the api-server `/ws` hub for every datafeed
// subscriber inside this tab, separate from `useChannel.ts` (which the
// rest of the app keeps using until T3 migrates it). Per-channel refcount
// means the last unsubscribe on a channel sends `unsub` to the server,
// but the socket itself stays open as long as any channel still has
// subscribers. Reconnect is capped exponential backoff with re-sub of
// every wanted channel on each successful open.
//
// Why not reuse `useChannel`? Two reasons:
//  1. The hook is React-bound; the datafeed is a plain TS singleton that
//     also serves non-React callers (e.g. the future TV adapter, the
//     debug harness). Calling React hooks from non-component code is a
//     non-starter.
//  2. Keeping the multiplexer inside the datafeed lets the contract
//     evolve (auth tokens, channel-level acks, custom backoff) without
//     touching the hook every other component depends on.
//
// During the deprecation window (T3 / T4) both clients coexist. Each
// opens its own socket, but the server treats them as independent
// subscribers and dedupes upstream subscriptions per-process anyway, so
// there is no double-fanout cost on the wire that matters.

import { normalizeSymbolKey } from "./normalize";

function explicitWsUrl(): string | null {
  const raw = (import.meta.env.VITE_WS_URL ?? "").trim();
  if (!raw) return null;

  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/ws") ? trimmed : `${trimmed}/ws`;
}

function sameOriginWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function resolveWsUrl(): string {
  return explicitWsUrl() ?? sameOriginWsUrl();
}

type ServerMessage =
  | { type: "snapshot"; channel: string; data: unknown }
  | { type: "delta"; channel: string; data: unknown }
  | { type: "hello"; t?: number }
  | { type: "pong"; t?: number }
  | { type: "error"; channel: string; message: string };

type ChannelListener = (data: unknown, kind: "snapshot" | "delta") => void;

interface ChannelEntry {
  listeners: Set<ChannelListener>;
  // Cached most-recent snapshot (or first delta if no snapshot arrived
  // yet). Late subscribers get this immediately so they don't have to
  // wait for the next tick to render.
  lastPayload: { data: unknown; kind: "snapshot" | "delta" } | null;
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "heatmap",
  "depth",
  "trades",
  "levels",
]);

// Mirrors the canonicalization the server applies to symbol-bearing
// channels. Subscribers must key on the canonical name or messages get
// dropped silently.
function canonicalize(channel: string): string {
  const colon = channel.indexOf(":");
  if (colon < 0) return channel;
  const kind = channel.slice(0, colon);
  if (!SYMBOL_KINDS.has(kind)) return channel;
  const symbol = normalizeSymbolKey(channel.slice(colon + 1));
  return `${kind}:${symbol}`;
}

class DatafeedWsClient {
  private ws: WebSocket | null = null;
  private channels = new Map<string, ChannelEntry>();
  private connecting = false;
  private reconnectMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outboundQueue: object[] = [];
  private outboundTimer: ReturnType<typeof setTimeout> | null = null;

  // The socket is intentionally NOT torn down on tab visibility change.
  // The Phase 3 task watchpoint asks that the connection only close on
  // full process teardown so that returning to a hidden tab does not
  // burn a reconnect + replay round-trip. Backgrounded WebSockets are
  // throttled by the browser but kept alive, which is the desired
  // behavior for a market-data stream.

  private connect(): void {
    if (this.connecting) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.connecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(resolveWsUrl());
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener("open", () => {
      if (this.ws !== socket) {
        try { socket.close(); } catch { /* swallow */ }
        return;
      }
      this.connecting = false;
      this.reconnectMs = 500;
      // datafeedWsDripReconnectV1: re-subscribe through the outbound drip
      // queue so reconnects do not burst dozens of frames at the server.
      for (const channel of this.channels.keys()) {
        this.enqueueSend({ op: "sub", channel });
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ op: "ping" }), 20_000);
    });

    socket.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type !== "snapshot" && msg.type !== "delta") return;
      const entry = this.channels.get(msg.channel);
      if (!entry) return;
      entry.lastPayload = { data: msg.data, kind: msg.type };
      for (const fn of entry.listeners) {
        try {
          fn(msg.data, msg.type);
        } catch {
          // Listener errors must not poison other listeners.
        }
      }
    });

    socket.addEventListener("close", () => {
      if (this.ws !== null && this.ws !== socket) return;
      this.connecting = false;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.outboundTimer) {
        clearTimeout(this.outboundTimer);
        this.outboundTimer = null;
      }
      this.outboundQueue = [];
      this.ws = null;
      if (this.channels.size > 0) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // swallow
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.channels.size === 0 || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.min(1_000, Math.max(100, this.reconnectMs * 0.2)));
    const ms = this.reconnectMs + jitter;
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.channels.size > 0) this.connect();
    }, ms);
  }

  private enqueueSend(op: object): void {
    if (this.outboundQueue.length > 500) this.outboundQueue.shift();
    this.outboundQueue.push(op);
    this.pumpOutboundQueue();
  }

  private pumpOutboundQueue(): void {
    if (this.outboundTimer) return;
    const tick = () => {
      this.outboundTimer = null;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const batch = this.outboundQueue.splice(0, 8);
      for (const op of batch) this.send(op);
      if (this.outboundQueue.length > 0) {
        this.outboundTimer = setTimeout(tick, 25);
      }
    };
    this.outboundTimer = setTimeout(tick, 0);
  }

  private send(op: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(op));
    } catch {
      // swallow
    }
  }

  /**
   * Subscribe a listener to a channel. Returns an unsubscriber. The first
   * subscriber on a channel triggers a server-side `sub`; the last
   * unsubscriber triggers `unsub`. The socket stays open while any
   * channel has subscribers.
   */
  subscribe(rawChannel: string, fn: ChannelListener): () => void {
    const channel = canonicalize(rawChannel);
    let entry = this.channels.get(channel);
    const isFirstSubscriber = !entry;
    if (!entry) {
      entry = { listeners: new Set(), lastPayload: null };
      this.channels.set(channel, entry);
    }
    entry.listeners.add(fn);

    if (isFirstSubscriber) {
      // New channel — ask the server for the snapshot+delta stream.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.enqueueSend({ op: "sub", channel });
      } else {
        this.connect();
      }
    } else if (entry.lastPayload) {
      // Late join: replay the last cached payload so this subscriber
      // doesn't have to wait for the next upstream tick to render.
      const cached = entry.lastPayload;
      // Defer to a microtask so callers that subscribe inside a
      // synchronous setup block (common in React effects) finish wiring
      // their state before the first callback fires.
      queueMicrotask(() => {
        if (entry!.listeners.has(fn)) fn(cached.data, cached.kind);
      });
    }

    return () => {
      const cur = this.channels.get(channel);
      if (!cur) return;
      cur.listeners.delete(fn);
      if (cur.listeners.size === 0) {
        this.channels.delete(channel);
        this.enqueueSend({ op: "unsub", channel });
        if (this.channels.size === 0) {
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          if (this.ws) {
            try { this.ws.close(); } catch { /* swallow */ }
            this.ws = null;
          }
          this.connecting = false;
          this.reconnectMs = 500;
        }
      }
    };
  }
}

let singleton: DatafeedWsClient | null = null;

export function getDatafeedWsClient(): DatafeedWsClient {
  if (!singleton) singleton = new DatafeedWsClient();
  return singleton;
}

// Test-only escape hatch. Never used in production code.
export function __resetDatafeedWsClient(): void {
  singleton = null;
}
