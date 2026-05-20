import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Play, Radio, AlertTriangle, Crosshair, Pause, Layers } from "lucide-react";
import {
  postLevelTouchScan,
  type ComboType,
  type LevelConfidence,
  type LevelSourceId,
  type LevelTouchRow,
  type UniverseMode,
} from "@/lib/levelScan";

const SOURCES: { id: LevelSourceId; label: string; short: string }[] = [
  { id: "kde", label: "KDE pivot clusters", short: "KDE" },
  { id: "market_profile", label: "Market profile (POC / VAH / VAL)", short: "MP" },
  { id: "quantile", label: "Quantile bands", short: "QTL" },
  { id: "pivots", label: "Swing pivots", short: "PVT" },
  { id: "liquidations", label: "Liquidation densities", short: "LIQ" },
];

const INTERVALS = ["1m", "1H", "4H", "1D"];

const COMBO_BADGE: Record<ComboType, string> = {
  both: "bg-fuchsia-500/20 border-fuchsia-400/50 text-fuchsia-200",
  structural: "bg-cyan-500/15 border-cyan-500/40 text-cyan-200",
  liquidity: "bg-amber-500/15 border-amber-500/40 text-amber-200",
};
const COMBO_LABEL: Record<ComboType, string> = {
  both: "S+L",
  structural: "S",
  liquidity: "L",
};
const CONFIDENCE: { id: LevelConfidence; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "medium", label: "Medium+" },
  { id: "high", label: "High only" },
];
const UNIVERSE: { id: UniverseMode; label: string; hint: string }[] = [
  { id: "warm", label: "Warm only", hint: "Active WS symbols only" },
  {
    id: "warm_plus_top",
    label: "Top by volume",
    hint: "Extends warm set with top-by-volume symbols. WS subs warm in the background; rerun the scan as data lands.",
  },
];

const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 15_000, label: "15s" },
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "1m" },
];

const NEW_ROW_HIGHLIGHT_MS = 4_000;

function rowKey(r: LevelTouchRow): string {
  // comboType is part of the key so a single symbol can appear up to
  // three times in `mode=buckets` (structural / liquidity / both)
  // without collisions.
  return `${r.symbol}::${r.comboType ?? "row"}::${r.level.source}::${r.timeframe}::${r.level.midPrice}`;
}

function heatmapHrefFor(r: LevelTouchRow): string {
  const params = new URLSearchParams();
  params.set("symbol", r.symbol);
  params.set("hlLow", String(r.level.priceLow));
  params.set("hlHigh", String(r.level.priceHigh));
  params.set("hlMid", String(r.level.midPrice));
  params.set("hlSrc", r.level.source);
  params.set("hlKind", r.level.kind);
  params.set("hlTf", r.timeframe);
  return `/?${params.toString()}`;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.001) return n.toFixed(6);
  if (a === 0) return "0";
  return n.toFixed(8);
}

const SIDE_COLOR: Record<LevelTouchRow["side"], string> = {
  inside: "text-amber-300",
  above: "text-rose-300",
  below: "text-emerald-300",
};

const CONF_COLOR: Record<LevelTouchRow["level"]["confidence"], string> = {
  high: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200",
  medium: "bg-amber-500/15 border-amber-500/40 text-amber-200",
  low: "bg-zinc-500/15 border-zinc-500/40 text-zinc-300",
};

const KIND_COLOR: Record<LevelTouchRow["level"]["kind"], string> = {
  support: "text-emerald-300",
  resistance: "text-rose-300",
  neutral: "text-white/60",
};

export function LevelTouchPanel() {
  const [interval, setInterval] = useState<string>("4H");
  const [tolerancePct, setTolerancePct] = useState<number>(0.25);
  const [minConfidence, setMinConfidence] = useState<LevelConfidence>("any");
  const [universeMode, setUniverseMode] = useState<UniverseMode>("warm");
  const [sources, setSources] = useState<Set<LevelSourceId>>(
    () => new Set<LevelSourceId>(SOURCES.map((s) => s.id)),
  );
  const [limit, setLimit] = useState<number>(50);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [refreshMs, setRefreshMs] = useState<number>(15_000);
  // 1m multi-touch mode: forces interval to "1m" and sends mode=buckets
  // so the backend emits separate structural / liquidity / both rows
  // per symbol. The combined "S+L" combo rows always sort first.
  const [bucketMode, setBucketMode] = useState<boolean>(false);
  // ATR(14)-sized tolerance — only effective on 1m. Sends
  // tolerancePct="auto" instead of the static slider value.
  const [autoTol, setAutoTol] = useState<boolean>(false);
  const [autoRescanWarmup, setAutoRescanWarmup] = useState<boolean>(false);
  const [warmingPeak, setWarmingPeak] = useState<number>(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [newKeys, setNewKeys] = useState<Set<string>>(() => new Set());
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const prevKeysRef = useRef<Set<string>>(new Set());
  const highlightTimersRef = useRef<Map<string, number>>(new Map());

  // 1m multi-touch always uses the 1m TF and the buckets mode regardless
  // of the user's TF selector — keeps the toggle's intent unambiguous.
  const effectiveInterval = bucketMode ? "1m" : interval;
  const effectiveTolerance: number | "auto" =
    autoTol && effectiveInterval === "1m" ? "auto" : tolerancePct;

  const scan = useMutation({
    mutationFn: () =>
      postLevelTouchScan({
        interval: effectiveInterval,
        tolerancePct: effectiveTolerance,
        minConfidence,
        sources: [...sources],
        universeMode,
        limit,
        mode: bucketMode ? "buckets" : "best_per_symbol",
      }),
    onSuccess: () => {
      setLastUpdatedAt(Date.now());
    },
  });

  const result = scan.data;
  const rows = result?.rows ?? [];

  // Track scan state in a ref so the auto-refresh timer always sees the latest
  // without needing to restart on every status change.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const canRunRef = useRef(true);

  // Detect newly-arrived rows for the brief highlight effect.
  useEffect(() => {
    if (!result) return;
    const currentKeys = new Set(rows.map(rowKey));
    const fresh: string[] = [];
    for (const k of currentKeys) {
      if (!prevKeysRef.current.has(k)) fresh.push(k);
    }
    prevKeysRef.current = currentKeys;
    if (fresh.length === 0) return;
    setNewKeys((prev) => {
      const next = new Set(prev);
      for (const k of fresh) next.add(k);
      return next;
    });
    for (const k of fresh) {
      const existing = highlightTimersRef.current.get(k);
      if (existing) window.clearTimeout(existing);
      const t = window.setTimeout(() => {
        setNewKeys((prev) => {
          if (!prev.has(k)) return prev;
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
        highlightTimersRef.current.delete(k);
      }, NEW_ROW_HIGHLIGHT_MS);
      highlightTimersRef.current.set(k, t);
    }
  }, [result, rows]);

  useEffect(() => {
    return () => {
      for (const t of highlightTimersRef.current.values()) window.clearTimeout(t);
      highlightTimersRef.current.clear();
    };
  }, []);

  // Auto-refresh polling loop.
  useEffect(() => {
    if (!autoRefresh) return;
    const tryFire = () => {
      const s = scanRef.current;
      if (!s.isPending && canRunRef.current) s.mutate();
    };
    tryFire();
    const id = window.setInterval(tryFire, refreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, refreshMs]);

  // Track the highest "warming" count we've seen since the last fully-warm
  // result so the inline progress bar has a sensible denominator. Resets
  // to zero whenever a scan reports no symbols still warming.
  const warming = result?.warming ?? 0;
  useEffect(() => {
    if (!result) return;
    if (warming === 0) {
      setWarmingPeak(0);
    } else {
      setWarmingPeak((p) => (warming > p ? warming : p));
    }
  }, [result, warming]);

  // Reset peak when switching universes — the previous baseline is no
  // longer meaningful.
  useEffect(() => {
    setWarmingPeak(0);
  }, [universeMode]);

  // Auto-rescan while warm-up is in progress. Fires every ~5s as long as
  // the most recent scan still reports warming symbols. Stops automatically
  // once warming reaches zero.
  useEffect(() => {
    if (!autoRescanWarmup) return;
    if (warming <= 0) return;
    const id = window.setTimeout(() => {
      const s = scanRef.current;
      if (!s.isPending && canRunRef.current) s.mutate();
    }, 5_000);
    return () => window.clearTimeout(id);
  }, [autoRescanWarmup, warming, lastUpdatedAt]);

  // "Xs ago" ticker — only runs while we have something to display.
  useEffect(() => {
    if (lastUpdatedAt === null) return;
    setNowTick(Date.now());
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lastUpdatedAt]);

  const toggleSource = (id: LevelSourceId): void => {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sourceShort = useMemo(
    () =>
      Object.fromEntries(SOURCES.map((s) => [s.id, s.short])) as Record<
        LevelSourceId,
        string
      >,
    [],
  );

  const canRun = sources.size > 0;
  canRunRef.current = canRun;

  const secondsAgo =
    lastUpdatedAt === null ? null : Math.max(0, Math.round((nowTick - lastUpdatedAt) / 1000));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 sm:px-4 py-2 border-b border-border bg-card/60 shrink-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
          LEVEL TOUCH
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <label className="text-muted-foreground hidden sm:inline">TF</label>
          <select
            value={effectiveInterval}
            disabled={bucketMode}
            onChange={(e) => setInterval(e.target.value)}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none disabled:opacity-60"
            title={
              bucketMode
                ? "1m multi-touch mode pins TF to 1m"
                : "Scan timeframe"
            }
          >
            {INTERVALS.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>

          <label
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border cursor-pointer transition-colors ${
              bucketMode
                ? "bg-fuchsia-500/15 border-fuchsia-400/50 text-fuchsia-200"
                : "bg-white/5 border-white/10 text-white/60 hover:text-white/80"
            }`}
            title="Scan ALL symbols on 1m for current touches of structural / liquidity / both. S+L combos rank first."
          >
            <input
              type="checkbox"
              className="accent-fuchsia-400 w-3 h-3"
              checked={bucketMode}
              onChange={(e) => setBucketMode(e.target.checked)}
            />
            <Layers className="w-3 h-3" />
            1m S+L
          </label>

          <label className="text-muted-foreground hidden sm:inline ml-1">TOL %</label>
          <input
            type="number"
            step={0.05}
            min={0.05}
            max={2}
            value={tolerancePct}
            disabled={autoTol && effectiveInterval === "1m"}
            onChange={(e) =>
              setTolerancePct(
                Math.max(0.05, Math.min(2, parseFloat(e.target.value) || 0.25)),
              )
            }
            className="w-16 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white text-[11px] outline-none tabular-nums disabled:opacity-50"
          />
          {effectiveInterval === "1m" && (
            <label
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border cursor-pointer transition-colors ${
                autoTol
                  ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                  : "bg-white/5 border-white/10 text-white/50 hover:text-white/80"
              }`}
              title="Auto-size tolerance from 1m ATR(14)"
            >
              <input
                type="checkbox"
                className="accent-cyan-400 w-3 h-3"
                checked={autoTol}
                onChange={(e) => setAutoTol(e.target.checked)}
              />
              auto
            </label>
          )}

          <label className="text-muted-foreground hidden sm:inline ml-1">CONF</label>
          <select
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value as LevelConfidence)}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none"
          >
            {CONFIDENCE.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <label className="text-muted-foreground hidden sm:inline ml-1">UNI</label>
          <select
            value={universeMode}
            onChange={(e) => setUniverseMode(e.target.value as UniverseMode)}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none"
            title={UNIVERSE.find((u) => u.id === universeMode)?.hint}
          >
            {UNIVERSE.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>

          <label className="text-muted-foreground hidden sm:inline ml-1">N</label>
          <input
            type="number"
            min={5}
            max={100}
            value={limit}
            onChange={(e) =>
              setLimit(Math.max(5, Math.min(100, parseInt(e.target.value, 10) || 50)))
            }
            className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white text-[11px] outline-none tabular-nums"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border cursor-pointer transition-colors ${
              autoRefresh
                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                : "bg-white/5 border-white/10 text-white/60 hover:text-white/80"
            }`}
            title={autoRefresh ? "Pause auto-refresh" : "Re-run scan automatically"}
          >
            <input
              type="checkbox"
              className="accent-emerald-400 w-3 h-3"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {autoRefresh ? (
              <Pause className="w-3 h-3" />
            ) : (
              <Radio className="w-3 h-3" />
            )}
            Auto
          </label>

          <select
            value={refreshMs}
            onChange={(e) => setRefreshMs(parseInt(e.target.value, 10))}
            disabled={!autoRefresh}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none disabled:opacity-40"
            title="Auto-refresh interval"
          >
            {REFRESH_INTERVALS.map((opt) => (
              <option key={opt.ms} value={opt.ms}>
                {opt.label}
              </option>
            ))}
          </select>

          <label
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border cursor-pointer transition-colors ${
              autoRescanWarmup
                ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
                : "bg-white/5 border-white/10 text-white/60 hover:text-white/80"
            }`}
            title="Automatically re-run the scan every few seconds while symbols are still warming up"
          >
            <input
              type="checkbox"
              className="accent-amber-400 w-3 h-3"
              checked={autoRescanWarmup}
              onChange={(e) => setAutoRescanWarmup(e.target.checked)}
            />
            Rescan on warm-up
          </label>

          {secondsAgo !== null && (
            <span
              className="text-[11px] text-white/40 tabular-nums hidden sm:inline"
              title={new Date(lastUpdatedAt!).toLocaleTimeString()}
            >
              {scan.isPending ? "updating…" : `updated ${secondsAgo}s ago`}
            </span>
          )}

          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending || !canRun}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 disabled:hover:bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 transition-colors"
          >
            <Play className="w-3 h-3" />
            {scan.isPending ? "Scanning…" : "Run scan"}
          </button>
        </div>
      </div>

      {/* Source checkboxes */}
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-1.5 border-b border-border bg-card/40 shrink-0">
        <span className="text-[11px] text-muted-foreground mr-1">Sources:</span>
        {SOURCES.map((s) => {
          const on = sources.has(s.id);
          return (
            <label
              key={s.id}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border cursor-pointer transition-colors ${
                on
                  ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                  : "bg-white/5 border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              <input
                type="checkbox"
                className="accent-cyan-400 w-3 h-3"
                checked={on}
                onChange={() => toggleSource(s.id)}
              />
              <span title={s.label}>{s.short}</span>
            </label>
          );
        })}
        {!canRun && (
          <span className="text-[11px] text-amber-400">Pick at least one source.</span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {scan.isError && (
          <div className="m-3 sm:m-4 p-3 rounded border border-rose-500/30 bg-rose-500/10 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{(scan.error as Error)?.message ?? "scan failed"}</span>
          </div>
        )}

        {!scan.isPending && !result && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-6 text-center">
            <Crosshair className="w-12 h-12 opacity-30" />
            <div className="text-sm">Find symbols touching structural levels</div>
            <div className="text-xs opacity-60 max-w-md">
              Pick a timeframe, tolerance, and which level sources to consider, then run a scan.
              Symbols whose live price is within tolerance of a matching level will appear here,
              sorted by touch quality.
            </div>
          </div>
        )}

        {scan.isPending && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-muted-foreground font-mono text-xs animate-pulse">
              SCANNING {interval.toUpperCase()} LEVELS…
            </div>
          </div>
        )}

        {result && (
          <>
            <div className="px-3 sm:px-4 py-1.5 border-b border-border text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
              <span>
                {rows.length} of {result.matched} shown · {result.scanned} scanned ({result.universeSize} in universe)
              </span>
              {(result.warming ?? 0) > 0 && (
                <span
                  className="text-amber-400/80 inline-flex items-center gap-1.5"
                  title={
                    autoRescanWarmup
                      ? "WS subscriptions for these symbols are still warming. Auto-rescan is on; results will refresh as they warm."
                      : "WS subscriptions for these symbols are still warming. Re-run the scan in a few seconds, or enable Rescan on warm-up."
                  }
                >
                  · {result.warming} warming
                  <span
                    className="relative inline-block w-12 h-1 rounded bg-amber-500/15 overflow-hidden align-middle"
                    aria-label="warm-up progress"
                  >
                    <span className="absolute inset-0 bg-amber-400/20 animate-pulse" />
                    {warmingPeak > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 bg-amber-400/80 transition-all duration-700"
                        style={{
                          width: `${Math.min(100, Math.max(4, (result.warming! / warmingPeak) * 100))}%`,
                        }}
                      />
                    )}
                  </span>
                </span>
              )}
              {(result.coldLevels ?? 0) > 0 && (
                <span
                  className="text-amber-400/60"
                  title="Live price is in, but the structural-levels cache is still computing for these symbols."
                >
                  · {result.coldLevels} levels pending
                </span>
              )}
              {result.warming === undefined &&
                result.coldLevels === undefined &&
                result.skipped > 0 && (
                  <span className="text-amber-400/80">
                    · {result.skipped} skipped (warming / no live price)
                  </span>
                )}
              {result.toleranceMode === "auto" ? (
                <span title="Tolerance auto-sized per symbol from 1m ATR(14)">· tol auto</span>
              ) : (
                <span>· tol ±{tolerancePct.toFixed(2)}%</span>
              )}
              <span>· {effectiveInterval}</span>
              <span>· {universeMode === "warm" ? "warm" : "top vol"}</span>
              {bucketMode && (
                <span className="text-fuchsia-300/80" title="Symbols touching BOTH structural and liquidity right now">
                  · {result.bothBucketCount ?? 0} S+L combos
                </span>
              )}
              {(result.candleOverlapHits ?? 0) > 0 && (
                <span className="text-cyan-300/70" title="Touches detected via latest 1m candle wick overlap">
                  · {result.candleOverlapHits} wick-overlap
                </span>
              )}
            </div>

            {rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-6 text-center">
                <Radio className="w-12 h-12 opacity-30" />
                <div className="text-sm">No symbols are touching levels right now</div>
                <div className="text-xs opacity-60">Try widening the tolerance or enabling more sources.</div>
              </div>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] uppercase text-white/40 border-b border-white/10">
                      <tr>
                        <th className="text-right px-2 py-2 w-10">#</th>
                        <th className="text-left px-3 py-2">Symbol</th>
                        {bucketMode && (
                          <th className="text-left px-2 py-2 w-14" title="Combo type">Combo</th>
                        )}
                        <th className="text-right px-3 py-2">Last</th>
                        <th className="text-right px-3 py-2">Mid</th>
                        <th className="text-right px-3 py-2">Band</th>
                        <th className="text-left px-3 py-2">Kind</th>
                        <th className="text-left px-3 py-2">Source</th>
                        <th className="text-left px-3 py-2">TF</th>
                        <th className="text-left px-3 py-2">Conf</th>
                        <th className="text-right px-3 py-2">Side</th>
                        <th className="text-right px-3 py-2">Dist %</th>
                        <th className="text-right px-3 py-2" title="Zone score from the structural-levels engine">Score</th>
                        <th className="text-right px-3 py-2" title="Combined touch quality (proximity × confidence × score)">Touch</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const isPoint = r.level.priceLow === r.level.priceHigh;
                        const band = isPoint
                          ? "—"
                          : `${fmtNum(r.level.priceLow)} – ${fmtNum(r.level.priceHigh)}`;
                        const k = rowKey(r);
                        const isNew = newKeys.has(k);
                        return (
                          <tr
                            key={k}
                            className={`border-b border-white/5 transition-colors duration-700 ${
                              isNew
                                ? "bg-cyan-400/15 hover:bg-cyan-400/20"
                                : "hover:bg-white/[0.02]"
                            }`}
                          >
                            <td className="px-2 py-1.5 text-right tabular-nums text-white/40">{i + 1}</td>
                            <td className="px-3 py-1.5">
                              <Link href={heatmapHrefFor(r)}>
                                <span
                                  className="text-cyan-300 hover:text-cyan-200 cursor-pointer font-medium"
                                  title="Open in heatmap with this level highlighted"
                                >
                                  {r.symbol}
                                </span>
                              </Link>
                            </td>
                            {bucketMode && (
                              <td className="px-2 py-1.5">
                                {r.comboType && (
                                  <span
                                    className={`px-1.5 py-px rounded border text-[10px] font-medium ${COMBO_BADGE[r.comboType]}`}
                                    title={
                                      r.comboType === "both"
                                        ? `Touching structural ${r.level.kind} AND liquidity ${r.companion?.kind ?? ""}`
                                        : r.comboType === "structural"
                                          ? "Touching a structural zone"
                                          : "Touching a liquidation density"
                                    }
                                  >
                                    {COMBO_LABEL[r.comboType]}
                                  </span>
                                )}
                              </td>
                            )}
                            <td className="px-3 py-1.5 text-right tabular-nums text-white/80">
                              {fmtNum(r.lastPrice)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-white/80">
                              {fmtNum(r.level.midPrice)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-white/60">{band}</td>
                            <td className={`px-3 py-1.5 ${KIND_COLOR[r.level.kind]}`}>
                              {r.level.kind}
                            </td>
                            <td className="px-3 py-1.5 text-white/70" title={r.level.methods.join(", ")}>
                              {sourceShort[r.level.source]}
                              {r.level.leverage ? ` ${r.level.leverage}x` : ""}
                            </td>
                            <td className="px-3 py-1.5 text-white/60 tabular-nums">{r.timeframe}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-1.5 py-px rounded border text-[10px] uppercase ${CONF_COLOR[r.level.confidence]}`}>
                                {r.level.confidence}
                              </span>
                            </td>
                            <td className={`px-3 py-1.5 text-right ${SIDE_COLOR[r.side]}`}>{r.side}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-white/70">
                              {r.distancePct.toFixed(3)}%
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-white/70">
                              {r.level.score.toFixed(2)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-cyan-200/90">
                              {r.touchScore.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-white/5">
                  {rows.map((r, i) => {
                    const isPoint = r.level.priceLow === r.level.priceHigh;
                    const k = rowKey(r);
                    const isNew = newKeys.has(k);
                    return (
                      <div
                        key={k}
                        className={`px-3 py-2.5 transition-colors duration-700 ${
                          isNew ? "bg-cyan-400/10" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] text-white/40 tabular-nums w-5 text-right">{i + 1}</span>
                            <Link href={heatmapHrefFor(r)}>
                              <span
                                className="text-sm text-cyan-300 font-medium"
                                title="Open in heatmap with this level highlighted"
                              >
                                {r.symbol}
                              </span>
                            </Link>
                            {bucketMode && r.comboType && (
                              <span
                                className={`px-1.5 py-px rounded border text-[10px] font-medium ${COMBO_BADGE[r.comboType]}`}
                              >
                                {COMBO_LABEL[r.comboType]}
                              </span>
                            )}
                            <span
                              className={`px-1.5 py-px rounded border text-[10px] uppercase ${CONF_COLOR[r.level.confidence]}`}
                            >
                              {r.level.confidence}
                            </span>
                            <span className="text-[10px] text-white/40 tabular-nums">{r.timeframe}</span>
                          </div>
                          <span className={`text-xs ${SIDE_COLOR[r.side]}`}>{r.side}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-white/60 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>
                            last <span className="text-white/80 tabular-nums">{fmtNum(r.lastPrice)}</span>
                          </span>
                          <span>
                            mid <span className="text-white/80 tabular-nums">{fmtNum(r.level.midPrice)}</span>
                          </span>
                          {!isPoint && (
                            <span className="text-white/50">
                              ({fmtNum(r.level.priceLow)} – {fmtNum(r.level.priceHigh)})
                            </span>
                          )}
                          <span>
                            dist <span className="text-white/80 tabular-nums">{r.distancePct.toFixed(3)}%</span>
                          </span>
                          <span>
                            score <span className="text-white/80 tabular-nums">{r.level.score.toFixed(2)}</span>
                          </span>
                          <span>
                            touch <span className="text-cyan-200/90 tabular-nums">{r.touchScore.toFixed(2)}</span>
                          </span>
                          <span className={KIND_COLOR[r.level.kind]}>{r.level.kind}</span>
                          <span className="text-white/60">
                            {sourceShort[r.level.source]}
                            {r.level.leverage ? ` ${r.level.leverage}x` : ""}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
