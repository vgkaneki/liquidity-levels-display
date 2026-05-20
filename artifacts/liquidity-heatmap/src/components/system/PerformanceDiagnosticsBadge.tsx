import { useEffect, useState } from "react";

type WsSnapshot = {
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
};

declare global {
  interface Window {
    __chartWsDiagnostics?: () => WsSnapshot;
  }
}

function enabled(): boolean {
  if (import.meta.env.VITE_PERFORMANCE_BADGE === "1") return true;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("perf") === "1";
}

function readSnapshot(): WsSnapshot | null {
  try {
    return window.__chartWsDiagnostics?.() ?? null;
  } catch {
    return null;
  }
}

// performanceDiagnosticsBadgeV1: hidden diagnostics overlay for quick mobile/
// browser checks. It only reads counters exposed by chartNetworkDiagnostics;
// it does not subscribe to market data or affect candles, levels, DOM,
// Bookmap, scoring, confluence, absorption, or touch classification.
export function PerformanceDiagnosticsBadge() {
  const [visible] = useState(() => enabled());
  const [snapshot, setSnapshot] = useState<WsSnapshot | null>(() => {
    if (!visible || typeof window === "undefined") return null;
    return readSnapshot();
  });

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setSnapshot(readSnapshot()), 2_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible) return null;
  const s = snapshot;
  return (
    <div className="fixed bottom-2 left-2 z-[9999] rounded border border-cyan-500/30 bg-black/80 px-2 py-1 font-mono text-[10px] leading-4 text-cyan-100 shadow-lg backdrop-blur">
      <div className="text-cyan-300">PERF DIAG</div>
      <div>ws active: {s?.activeSockets ?? 0} / connecting: {s?.connectingSockets ?? 0}</div>
      <div>reconnects: {s?.reconnectScheduledCount ?? 0} / errors: {s?.errorCount ?? 0}</div>
      <div>channels: {s?.wantedChannels ?? 0} / listeners: {s?.listenerChannels ?? 0}</div>
      <div>last: {s?.lastEvent ?? "none"}</div>
    </div>
  );
}
