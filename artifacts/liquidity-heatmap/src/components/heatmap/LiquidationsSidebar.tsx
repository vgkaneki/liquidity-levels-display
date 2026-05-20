import { useGetLiquidations } from "@workspace/api-client-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Flame } from "lucide-react";

interface LiquidationsSidebarProps {
  symbol: string;
}

function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function relativeTime(ts: string, now: number): string {
  const diff = Math.max(0, now - new Date(ts).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function LiquidationsSidebar({ symbol }: LiquidationsSidebarProps) {
  const { data: apiData, isLoading } = useGetLiquidations(
    { symbol, limit: 50 },
    { query: { refetchInterval: 3000 } }
  );

  // Always trust the live feed. If OKX has no recent liquidations for this
  // symbol the sidebar shows an honest empty state — no synthetic noise.
  const data = apiData;

  // Tick a clock every second so "5s ago" labels stay live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const lastSeenIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (data?.[0]) lastSeenIdRef.current = data[0].id;
  }, [data]);

  // Stats summary across the visible feed
  const stats = useMemo(() => {
    if (!data?.length) return { total: 0, longs: 0, shorts: 0, biggest: null as null | { side: string; usdValue: number } };
    let total = 0, longs = 0, shorts = 0;
    let biggest = data[0]!;
    for (const l of data) {
      total += l.usdValue;
      if (l.side === "long") longs += l.usdValue; else shorts += l.usdValue;
      if (l.usdValue > biggest.usdValue) biggest = l;
    }
    return { total, longs, shorts, biggest };
  }, [data]);

  return (
    <div className="w-72 border-l border-border bg-card flex flex-col shrink-0">
      <div className="h-10 border-b border-border flex items-center justify-between px-3 gap-2 bg-gradient-to-r from-orange-950/40 to-red-950/40">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <span className="text-xs font-bold text-foreground tracking-wider">REKT FEED</span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">{data?.length ?? 0} EVENTS</span>
      </div>

      {/* Summary strip */}
      {data && data.length > 0 && (
        <div className="border-b border-border px-3 py-2 bg-muted/20">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <div className="text-[9px] font-mono uppercase text-muted-foreground tracking-wider">Longs Liq</div>
              <div className="text-xs font-bold text-red-400 tabular-nums">{formatUsd(stats.longs)}</div>
            </div>
            <div>
              <div className="text-[9px] font-mono uppercase text-muted-foreground tracking-wider">Shorts Liq</div>
              <div className="text-xs font-bold text-green-400 tabular-nums">{formatUsd(stats.shorts)}</div>
            </div>
          </div>
          {/* Long vs short ratio bar */}
          <div className="h-1.5 rounded overflow-hidden bg-muted flex">
            <div
              className="bg-red-500/80"
              style={{ width: `${stats.total > 0 ? (stats.longs / stats.total) * 100 : 50}%` }}
            />
            <div
              className="bg-green-500/80"
              style={{ width: `${stats.total > 0 ? (stats.shorts / stats.total) * 100 : 50}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {!data && isLoading ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-14 bg-muted/40 rounded animate-pulse" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <div className="p-6 text-center text-xs font-mono text-muted-foreground">
            No liquidations yet
          </div>
        ) : (
          <div>
            {data.map((liq, idx) => {
              const isLong = liq.side === "long";
              const isFresh = idx === 0 && liq.id !== lastSeenIdRef.current;
              const isWhale = liq.usdValue >= 100_000;
              return (
                <div
                  key={liq.id}
                  className={`group relative flex items-stretch border-b border-border/40 last:border-b-0 transition-colors ${
                    isLong ? "hover:bg-red-500/5" : "hover:bg-green-500/5"
                  } ${isFresh ? "animate-pulse-once" : ""}`}
                >
                  {/* Side indicator strip */}
                  <div className={`w-1 ${isLong ? "bg-red-500" : "bg-green-500"} ${isWhale ? "shadow-[0_0_8px_currentColor]" : ""}`} />

                  <div className="flex-1 px-2.5 py-2">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        {isLong ? (
                          <ArrowDown className="w-3 h-3 text-red-400" />
                        ) : (
                          <ArrowUp className="w-3 h-3 text-green-400" />
                        )}
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isLong ? "text-red-400" : "text-green-400"}`}>
                          {liq.side} LIQ
                        </span>
                        {isWhale && (
                          <Flame className="w-3 h-3 text-orange-400" />
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                        {relativeTime(liq.timestamp, now)} ago
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-bold text-foreground tabular-nums">
                        {formatUsd(liq.usdValue)}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                        @ ${liq.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="text-[9px] font-mono text-muted-foreground/70 mt-0.5">
                      {formatTime(liq.timestamp)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
