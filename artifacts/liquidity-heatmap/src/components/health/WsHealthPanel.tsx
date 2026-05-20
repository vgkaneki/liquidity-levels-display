import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

interface BookHealth {
  connected: boolean;
  healthy: boolean;
  subscriptions?: number;
  reconnectAttempts: number;
  connectedAgeMs: number | null;
  lastPongAgeMs?: number | null;
  lastMessageAgeMs?: number | null;
  cache?: number;
  oldestTickerAgeMs?: number | null;
  oldestAssetAgeMs?: number | null;
  universeSize?: number | null;
  universeAgeMs?: number | null;
}

interface LiqHealth {
  connected: boolean;
  healthy: boolean;
  reconnectAttempts: number;
  connectedAgeMs: number | null;
  lastPongAgeMs: number | null;
  lastEventAgeMs: number | null;
  symbolsWithEvents: number;
  subscribedSymbols?: number;
  subscribedCoins?: number;
  totalEvents: number;
  detectMode?: string;
  sizeUsdThreshold?: number | null;
}

interface WsHealth {
  okx: BookHealth;
  hl: BookHealth;
  okxLiquidations: LiqHealth;
  hlLiquidations: LiqHealth;
  bybitLiquidations: LiqHealth;
  binanceLiquidations: LiqHealth;
}

function formatAge(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function StatusDot({ healthy, connected }: { healthy: boolean; connected: boolean }) {
  const color = healthy
    ? "bg-green-500"
    : connected
      ? "bg-amber-500"
      : "bg-red-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-3 text-[11px] font-mono">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function BookTile({ title, h }: { title: string; h: BookHealth }) {
  return (
    <div className="rounded border border-border bg-card p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{title}</span>
        <StatusDot healthy={h.healthy} connected={h.connected} />
      </div>
      <Row label="connected" value={h.connected ? "yes" : "no"} />
      <Row label="reconnects" value={h.reconnectAttempts} />
      <Row label="up for" value={formatAge(h.connectedAgeMs)} />
      <Row
        label="last msg"
        value={formatAge(h.lastMessageAgeMs ?? h.lastPongAgeMs ?? null)}
      />
      {h.subscriptions != null && <Row label="subs" value={h.subscriptions} />}
      {h.universeSize != null && <Row label="universe" value={h.universeSize} />}
    </div>
  );
}

function LiqTile({ title, h }: { title: string; h: LiqHealth }) {
  const subs = h.subscribedSymbols ?? h.subscribedCoins;
  return (
    <div className="rounded border border-border bg-card p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{title}</span>
        <StatusDot healthy={h.healthy} connected={h.connected} />
      </div>
      <Row label="connected" value={h.connected ? "yes" : "no"} />
      <Row label="reconnects" value={h.reconnectAttempts} />
      <Row label="up for" value={formatAge(h.connectedAgeMs)} />
      <Row label="last pong" value={formatAge(h.lastPongAgeMs)} />
      <Row label="last event" value={formatAge(h.lastEventAgeMs)} />
      <Row label="symbols" value={h.symbolsWithEvents} />
      {subs != null && <Row label="subs" value={subs} />}
      <Row label="events" value={h.totalEvents} />
    </div>
  );
}

export function WsHealthPanel({ pollMs = 5000 }: { pollMs?: number }) {
  const [data, setData] = useState<WsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(apiUrl(`/api/liquidity/ws-health`), {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
        } else {
          const json = (await res.json()) as WsHealth;
          if (!cancelled) {
            setData(json);
            setError(null);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  if (error && !data) {
    return (
      <div className="p-3 text-xs text-red-500">Failed to load feed health: {error}</div>
    );
  }
  if (!data) {
    return <div className="p-3 text-xs text-muted-foreground">Loading feed health…</div>;
  }

  return (
    <div className="space-y-3 p-2">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Order books
        </div>
        <div className="grid grid-cols-2 gap-2">
          <BookTile title="OKX" h={data.okx} />
          <BookTile title="Hyperliquid" h={data.hl} />
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Liquidation feeds
        </div>
        <div className="grid grid-cols-2 gap-2">
          <LiqTile title="OKX" h={data.okxLiquidations} />
          <LiqTile title="Hyperliquid" h={data.hlLiquidations} />
          <LiqTile title="Bybit" h={data.bybitLiquidations} />
          <LiqTile title="Binance" h={data.binanceLiquidations} />
        </div>
      </div>
    </div>
  );
}
