export interface ChartWsDiagnosticsSnapshot {
  activeSockets: number;
  connectingSockets: number;
  openCount: number;
  closeCount: number;
  errorCount: number;
  reconnectScheduledCount: number;
  subscribeCount: number;
  unsubscribeCount: number;
  wantedChannels: number;
  listenerChannels: number;
  lastEvent: string | null;
  lastUrl: string | null;
  lastEventAt: number | null;
}

const diagnostics: ChartWsDiagnosticsSnapshot = {
  activeSockets: 0,
  connectingSockets: 0,
  openCount: 0,
  closeCount: 0,
  errorCount: 0,
  reconnectScheduledCount: 0,
  subscribeCount: 0,
  unsubscribeCount: 0,
  wantedChannels: 0,
  listenerChannels: 0,
  lastEvent: null,
  lastUrl: null,
  lastEventAt: null,
};

function clampNonNegative(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

// chartWsDiagnosticsV1: lightweight browser-side WebSocket diagnostics. This
// does not affect market data, subscriptions, DOM, Bookmap, levels, scoring, or
// engine calculations. It only exposes counters so noisy mobile reconnects can
// be confirmed/debugged without guessing.
export function recordWsDiagnostic(
  event:
    | "connect-start"
    | "open"
    | "close"
    | "error"
    | "reconnect-scheduled"
    | "subscribe"
    | "unsubscribe"
    | "pause"
    | "resume",
  meta: { url?: string; wantedChannels?: number; listenerChannels?: number } = {},
): void {
  diagnostics.lastEvent = event;
  diagnostics.lastEventAt = Date.now();
  if (meta.url) diagnostics.lastUrl = meta.url;
  if (typeof meta.wantedChannels === "number") {
    diagnostics.wantedChannels = clampNonNegative(meta.wantedChannels);
  }
  if (typeof meta.listenerChannels === "number") {
    diagnostics.listenerChannels = clampNonNegative(meta.listenerChannels);
  }

  if (event === "connect-start") diagnostics.connectingSockets += 1;
  if (event === "open") {
    diagnostics.openCount += 1;
    diagnostics.activeSockets = 1;
    diagnostics.connectingSockets = clampNonNegative(diagnostics.connectingSockets - 1);
  }
  if (event === "close") {
    diagnostics.closeCount += 1;
    diagnostics.activeSockets = 0;
    diagnostics.connectingSockets = clampNonNegative(diagnostics.connectingSockets - 1);
  }
  if (event === "error") diagnostics.errorCount += 1;
  if (event === "reconnect-scheduled") diagnostics.reconnectScheduledCount += 1;
  if (event === "subscribe") diagnostics.subscribeCount += 1;
  if (event === "unsubscribe") diagnostics.unsubscribeCount += 1;

  if (typeof window !== "undefined") {
    const w = window as typeof window & {
      __chartWsDiagnostics?: () => ChartWsDiagnosticsSnapshot;
    };
    if (!w.__chartWsDiagnostics) {
      w.__chartWsDiagnostics = getWsDiagnosticsSnapshot;
    }
  }
}

export function getWsDiagnosticsSnapshot(): ChartWsDiagnosticsSnapshot {
  return { ...diagnostics };
}
