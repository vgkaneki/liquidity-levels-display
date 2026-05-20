import { useEffect, useRef, useState, useCallback } from "react";
import { normalizeSymbolKey } from "@/datafeed/normalize";
import { recordWsDiagnostic } from "@/lib/chartNetworkDiagnostics";

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

// Single shared WebSocket per browser tab. Routes inbound messages to the
// per-channel subscriber list. Reconnects with capped exponential backoff
// and pauses when the tab is hidden so we don't waste cycles on a deck of
// background tabs.

type ChannelMessage =
  | { type: "snapshot"; channel: string; data: unknown }
  | { type: "delta"; channel: string; data: unknown }
  | { type: "hello"; t: number }
  | { type: "pong"; t: number }
  | { type: "error"; channel: string; message: string };

type Listener = (msg: ChannelMessage) => void;

class ChannelClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  // Channels we want to be subscribed to; resent on reconnect.
  private wanted = new Set<string>();
  private reconnectMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private connecting = false;
  // wsRafCoalesceV1: high-frequency visual streams can burst faster than
  // React/canvas should be notified. Coalesce only visual snapshot/delta
  // channels to one latest message per animation frame. Non-visual channels
  // still dispatch immediately, so alerts/control messages are not delayed.
  private visualFrameQueue = new Map<string, ChannelMessage>();
  private visualFrameRaf: number | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.pause();
        } else {
          this.resume();
        }
      });
    }
  }

  private socketUrl(): string {
    return explicitWsUrl() ?? sameOriginWsUrl();
  }

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

    let ws: WebSocket;
    const url = this.socketUrl();
    try {
      ws = new WebSocket(url);
      recordWsDiagnostic("connect-start", {
        url,
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
    } catch {
      recordWsDiagnostic("error", {
        url,
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.addEventListener("open", () => {
      // Stale-event guard: a previous pause()/connect() cycle may have
      // already replaced `this.ws` with a newer socket before this
      // open event fires. If so, treat ourselves as superseded — close
      // this orphan and do nothing else, so we don't accidentally
      // mutate state owned by the current socket.
      if (this.ws !== ws) {
        try { ws.close(); } catch { /* swallow */ }
        return;
      }

      this.connecting = false;
      this.reconnectMs = 500;
      recordWsDiagnostic("open", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });

      // If the tab went hidden while the socket was still CONNECTING,
      // pause() deferred the teardown to avoid the "closed before
      // connection is established" browser warning. Honor that intent
      // now that the socket has cleanly opened: close it the regular
      // way, which fires the close handler and (because paused=true)
      // does NOT schedule a reconnect.
      if (this.paused) {
        try {
          ws.close();
        } catch {
          // swallow
        }
        return;
      }

      for (const ch of this.wanted) {
        this.sendOp({ op: "sub", channel: ch });
      }

      if (this.pingTimer) {
        clearInterval(this.pingTimer);
      }

      this.pingTimer = setInterval(() => {
        this.sendOp({ op: "ping" });
      }, 20_000);
    });

    ws.addEventListener("message", (ev) => {
      let msg: ChannelMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      this.deliver(msg);
    });

    ws.addEventListener("close", () => {
      // Stale-event guard: if `this.ws` already points at a *different*
      // socket (because pause() torn us down and resume()/connect() spun
      // up a successor before our close event fired), do nothing — we
      // would otherwise null out the live socket reference and trigger
      // a phantom reconnect that races the healthy current connection.
      if (this.ws !== null && this.ws !== ws) {
        return;
      }

      this.connecting = false;

      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }

      this.ws = null;
      recordWsDiagnostic("close", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });

      if (!this.paused) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // swallow
      }
    });
  }

  private isVisualChannel(channel: string): boolean {
    return (
      channel.startsWith("heatmap:") ||
      channel.startsWith("depth:") ||
      channel.startsWith("levels:")
    );
  }

  private dispatch(msg: ChannelMessage): void {
    if (!("channel" in msg)) return;
    const set = this.listeners.get(msg.channel);
    if (!set) return;
    for (const fn of set) {
      fn(msg);
    }
  }

  private flushVisualFrameQueue(): void {
    this.visualFrameRaf = null;
    if (this.paused || this.visualFrameQueue.size === 0) {
      this.visualFrameQueue.clear();
      return;
    }

    const batch = Array.from(this.visualFrameQueue.values());
    this.visualFrameQueue.clear();
    for (const msg of batch) {
      this.dispatch(msg);
    }
  }

  private deliver(msg: ChannelMessage): void {
    if (!("channel" in msg)) return;

    if ((msg.type === "snapshot" || msg.type === "delta") && this.isVisualChannel(msg.channel)) {
      this.visualFrameQueue.set(msg.channel, msg);
      if (this.visualFrameRaf == null) {
        this.visualFrameRaf = window.requestAnimationFrame(() => this.flushVisualFrameQueue());
      }
      return;
    }

    this.dispatch(msg);
  }

  private scheduleReconnect(): void {
    if (this.paused || this.wanted.size === 0 || this.reconnectTimer) return;
    // chartRequestDebounceV1: avoid reconnect chatter from rapid route mounts,
    // mobile visibility flips, or immediate close/open loops. Keep the existing
    // exponential backoff but never reconnect faster than 900ms.
    const ms = Math.max(900, this.reconnectMs);
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);
    recordWsDiagnostic("reconnect-scheduled", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.paused && this.wanted.size > 0) {
        this.connect();
      }
    }, ms);
  }

  private sendOp(op: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(JSON.stringify(op));
    } catch {
      // swallow
    }
  }

  pause(): void {
    this.paused = true;
    recordWsDiagnostic("pause", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.visualFrameRaf != null) {
      window.cancelAnimationFrame(this.visualFrameRaf);
      this.visualFrameRaf = null;
    }
    this.visualFrameQueue.clear();

    if (!this.ws) return;

    // Only tear down a socket that has actually finished its WebSocket
    // upgrade. Calling close() on a CONNECTING socket triggers the
    // browser warning "WebSocket is closed before the connection is
    // established" and shows up as a noisy failure in DevTools even
    // though it's just a normal visibility transition. Defer the close
    // to the open handler (which checks `paused` and shuts down
    // cleanly). For sockets in CLOSING/CLOSED, there's nothing to do.
    const state = this.ws.readyState;
    if (state === WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {
        // swallow
      }
      this.ws = null;
    } else if (state === WebSocket.CONNECTING) {
      // Leave the socket alone; the open handler will close it because
      // `this.paused` is now true. Do NOT null `this.ws` here — connect()
      // uses it to detect an in-flight connection and skip duplicates.
      return;
    } else {
      // CLOSING / CLOSED — drop our reference so a subsequent resume()
      // can spin up a fresh socket.
      this.ws = null;
    }
  }

  resume(): void {
    if (!this.paused) return;

    this.paused = false;
    recordWsDiagnostic("resume", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    if (this.listeners.size > 0) {
      this.connect();
    }
  }

  subscribe(channel: string, fn: Listener): () => void {
    let set = this.listeners.get(channel);

    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }

    set.add(fn);
    recordWsDiagnostic("subscribe", {
      url: this.socketUrl(),
      wantedChannels: this.wanted.size,
      listenerChannels: this.listeners.size,
    });

    if (!this.wanted.has(channel)) {
      this.wanted.add(channel);

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendOp({ op: "sub", channel });
      } else {
        this.connect();
      }
    }

    return () => {
      const cur = this.listeners.get(channel);
      if (!cur) return;

      cur.delete(fn);
      recordWsDiagnostic("unsubscribe", {
        url: this.socketUrl(),
        wantedChannels: this.wanted.size,
        listenerChannels: this.listeners.size,
      });

      if (cur.size === 0) {
        this.listeners.delete(channel);
        this.wanted.delete(channel);
        this.sendOp({ op: "unsub", channel });

        if (this.wanted.size === 0) {
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          if (this.visualFrameRaf != null) {
            window.cancelAnimationFrame(this.visualFrameRaf);
            this.visualFrameRaf = null;
          }
          this.visualFrameQueue.clear();
          if (this.ws) {
            // chartRequestDebounceV1: do not close CONNECTING sockets from the
            // unsubscribe path; browsers log that as a noisy failure. Let the
            // existing open/paused guard close cleanly once the upgrade finishes.
            const state = this.ws.readyState;
            if (state === WebSocket.OPEN) {
              try { this.ws.close(); } catch { /* swallow */ }
              this.ws = null;
            } else if (state === WebSocket.CONNECTING) {
              // Keep the reference so connect() can still see the in-flight socket.
            } else {
              this.ws = null;
            }
          }
          this.connecting = false;
          this.reconnectMs = 500;
        }
      }
    };
  }
}

let clientSingleton: ChannelClient | null = null;

function getClient(): ChannelClient {
  if (!clientSingleton) {
    clientSingleton = new ChannelClient();
  }
  return clientSingleton;
}

// Channel-name canonicalization. The server normalizes symbol-bearing
// channels (heatmap/depth/trades/levels) by stripping the dash from the
// symbol and uppercasing it, then echoes deltas back on that canonical
// name. Subscribers must key on the same canonical form or messages will
// be dropped silently.
const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  "heatmap",
  "depth",
  "trades",
  "levels",
]);

function canonicalizeChannel(channel: string): string {
  const colon = channel.indexOf(":");
  if (colon < 0) return channel;

  const kind = channel.slice(0, colon);
  if (!SYMBOL_KINDS.has(kind)) return channel;

  const symbol = normalizeSymbolKey(channel.slice(colon + 1));
  return `${kind}:${symbol}`;
}

// Subscribe to a channel and receive every message (snapshot + deltas).
export function useChannel<T = unknown>(
  channel: string | null,
  onMessage: (data: T, kind: "snapshot" | "delta") => void,
): void {
  const cb = useRef(onMessage);
  cb.current = onMessage;

  useEffect(() => {
    if (!channel) return;

    const canonical = canonicalizeChannel(channel);
    const unsub = getClient().subscribe(canonical, (msg) => {
      if (msg.type === "snapshot" || msg.type === "delta") {
        cb.current(msg.data as T, msg.type);
      }
    });

    return unsub;
  }, [channel]);
}

// Subscribe to a channel and just expose the latest payload.
export function useChannelSnapshot<T = unknown>(
  channel: string | null,
): { data: T | null; isLive: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [isLive, setIsLive] = useState(false);

  const handler = useCallback((d: T) => {
    setData(d);
    setIsLive(true);
  }, []);

  useChannel<T>(channel, handler);

  useEffect(() => {
    setIsLive(false);
    setData(null);
  }, [channel]);

  return { data, isLive };
}
