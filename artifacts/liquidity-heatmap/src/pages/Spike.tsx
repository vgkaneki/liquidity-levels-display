// SPIKE-ONLY — TradingView integration feasibility check.
// Isolated route at /spike. The production chart at "/" is untouched.
// Renderer is `lightweight-charts` (TV's own OSS library) used as a
// stand-in for the TV Charting Library — same `IBasicDataFeed`-shaped
// adapter, same coordinate-API contract, swap to TV is mechanical
// once the vendored library lands.
//
// Phase 3 / T126: this page now drives all of its data through the
// shared `IDatafeed` (T2). The previous inline `tvDatafeed.ts`
// adapter is gone; the same datafeed that powers the production
// chart drives the spike, proving the contract is renderer-agnostic.
//
// What this page proves:
//   1. Datafeed plumbing against the real backend, via the shared
//      `IDatafeed.fetchCandles` / `subscribeBars`.
//   2. Symbol switching (no full reload).
//   3. Timeframe switching (no full reload).
//   4. Live rightmost-candle ticks via the datafeed's `subscribeBars`,
//      with rollover handled inside the datafeed (not the page).
//   5. Heatmap-band overlay sync driven by `subscribeLevels` /
//      `subscribeMark` from the same datafeed.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";
import { getDatafeed } from "@/datafeed";
import { normalizeIntervalKey, normalizeSymbolKey } from "@/datafeed/normalize";
import {
  INTERVAL_MS,
  type Bar,
  type LevelItem,
  type Resolution,
} from "@/datafeed/types";
import { HeatmapOverlay, type HeatmapLevel } from "@/spike/heatmapOverlay";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const RESOLUTIONS: Array<{ id: Resolution; label: string }> = [
  { id: "1m", label: "1m" },
  { id: "5m", label: "5m" },
  { id: "15m", label: "15m" },
  { id: "1H", label: "1h" },
  { id: "4H", label: "4h" },
  { id: "1D", label: "1D" },
];

// Default interval used for the initial overlay seed via fetchLevels
// (subscribeLevels then keeps it in sync). The /spike route is a
// developer-only chart, so a single sensible default is enough.
const OVERLAY_LEVELS_INTERVAL = "1D";

function barToCandle(b: Bar): CandlestickData {
  return {
    time: Math.floor(b.time / 1000) as UTCTimestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  };
}

// Map an `IDatafeed` `LevelItem` to the overlay's `HeatmapLevel`. The
// overlay's drawing math (heatmapOverlay.ts) is preserved untouched —
// we just need to project the contract's strength/method fields onto
// the overlay's heatScore / compositeScore / isLiquidationCluster
// shape. This is a pure transport adapter, no engine math.
function levelToHeatmap(lv: LevelItem): HeatmapLevel {
  const isLiq =
    lv.method === "liquidation" ||
    (Array.isArray(lv.methods) && lv.methods.includes("liquidation"));
  const intensity = Math.min(1, Math.max(0, lv.strength ?? 0));
  return {
    price: lv.price,
    totalSize: 0,
    heatScore: intensity,
    compositeScore: intensity,
    isLiquidationCluster: isLiq,
  };
}

export default function Spike() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayRef = useRef<HeatmapOverlay | null>(null);
  const lastBarRef = useRef<Bar | null>(null);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [resolution, setResolution] = useState<Resolution>("5m");
  const normalizedSymbol = useMemo(() => normalizeSymbolKey(symbol), [symbol]);
  const normalizedResolution = useMemo(() => normalizeIntervalKey(resolution) as Resolution, [resolution]);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState<string | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [lastClose, setLastClose] = useState<number | null>(null);
  const [markPrice, setMarkPrice] = useState<number | null>(null);
  const [markTickCount, setMarkTickCount] = useState(0);
  const [overlayDiag, setOverlayDiag] = useState({
    syncFrames: 0,
    syncDrops: 0,
    dropRatio: 0,
    lastDrawMsAgo: -1,
    levelsRendered: 0,
    levelsOffscreen: 0,
  });
  const [loadMs, setLoadMs] = useState<number | null>(null);

  // Chart bootstrap — once per mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e14" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // Mount the overlay AFTER the chart exists.
    overlayRef.current = new HeatmapOverlay(containerRef.current, chart, series, {
      bandHalfWidth: (_lvl, all) => {
        if (all.length < 2) return 5;
        // Median nearest-neighbor distance, halved.
        const sorted = [...all].sort((a, b) => a.price - b.price);
        const gaps: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
          gaps.push(sorted[i]!.price - sorted[i - 1]!.price);
        }
        gaps.sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)] ?? 5;
        return median * 0.45;
      },
    });

    return () => {
      overlayRef.current?.dispose();
      overlayRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // (Re)load bars on symbol/resolution change via the shared datafeed.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    let cancelled = false;
    setStatus("loading");
    setTickCount(0);
    overlayRef.current?.resetCounters();
    const t0 = performance.now();
    getDatafeed()
      .fetchCandles({ symbol: normalizedSymbol, resolution: normalizedResolution, limit: 300 })
      .then((res) => {
        if (cancelled) return;
        const dt = Math.round(performance.now() - t0);
        setLoadMs(dt);
        setSource(res.source);
        if (res.bars.length === 0) {
          setStatus("no-data");
          series.setData([]);
          lastBarRef.current = null;
          return;
        }
        series.setData(res.bars.map(barToCandle));
        lastBarRef.current = res.bars[res.bars.length - 1] ?? null;
        setLastClose(lastBarRef.current?.close ?? null);
        chart.timeScale().fitContent();
        setStatus("live");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`error: ${msg}`);
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedSymbol, normalizedResolution]);

  // Live tick subscription via the shared datafeed. Rollover semantics
  // now live inside the datafeed (`localRollover.ts`), exercised by
  // both production and spike — so the page just renders bars.
  useEffect(() => {
    if (status !== "live") return;
    const series = seriesRef.current;
    if (!series) return;
    const sub = getDatafeed().subscribeBars(
      { symbol: normalizedSymbol, resolution: normalizedResolution, lastBar: lastBarRef.current },
      (bar) => {
        lastBarRef.current = bar;
        setLastClose(bar.close);
        setTickCount((n) => n + 1);
        try {
          series.update(barToCandle(bar));
        } catch {
          // series may be transitioning
        }
      },
    );
    return () => sub.unsubscribe();
  }, [normalizedSymbol, normalizedResolution, status]);

  // Heatmap overlay levels — seeded by `fetchLevels` then kept in sync
  // by `subscribeLevels`. Both come from the shared datafeed.
  useEffect(() => {
    let cancelled = false;
    const datafeed = getDatafeed();

    // Initial seed so the overlay has something to draw immediately.
    void datafeed
      .fetchLevels({ symbol: normalizedSymbol, interval: normalizeIntervalKey(OVERLAY_LEVELS_INTERVAL) })
      .then((res) => {
        if (cancelled) return;
        overlayRef.current?.setLevels(res.levels.map(levelToHeatmap));
      })
      .catch(() => {
        // ignore — the WS subscription below will fill in shortly
      });

    // Live deltas. The `levels:<SYM>` channel carries full snapshots
    // (the registry payload isn't large) so each delta is a complete
    // replacement.
    const sub = datafeed.subscribeLevels(normalizedSymbol, (delta) => {
      if (cancelled) return;
      overlayRef.current?.setLevels(delta.levels.map(levelToHeatmap));
    });

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [normalizedSymbol]);

  // Mark price stream — proves the mark path of `IDatafeed` is also
  // wired through the spike. Surfaced in the diagnostics row so the
  // migration is verifiable, not dead-code.
  useEffect(() => {
    setMarkPrice(null);
    setMarkTickCount(0);
    const sub = getDatafeed().subscribeMark(normalizedSymbol, (tick) => {
      setMarkPrice(tick.markPrice);
      setMarkTickCount((n) => n + 1);
    });
    return () => sub.unsubscribe();
  }, [normalizedSymbol]);

  // Diagnostics tick — read overlay sync stats every 500ms.
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = overlayRef.current?.getDiagnostics();
      if (d) setOverlayDiag(d);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const intervalLabel = useMemo(
    () => RESOLUTIONS.find((r) => r.id === resolution)?.label ?? resolution,
    [resolution],
  );
  const intervalMs = useMemo(() => INTERVAL_MS[resolution], [resolution]);

  return (
    <div className="flex flex-col h-full bg-[#0b0e14] text-gray-200">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 flex-wrap">
        <span className="text-sm font-semibold text-amber-400">SPIKE</span>
        <span className="text-xs text-gray-500">/spike (isolated, production chart untouched)</span>

        <div className="flex items-center gap-1 ml-4">
          <span className="text-xs text-gray-500 mr-1">symbol:</span>
          {SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`px-2 py-1 text-xs rounded ${
                symbol === s ? "bg-amber-500 text-black" : "bg-gray-800 hover:bg-gray-700"
              }`}
              data-testid={`spike-symbol-${s}`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-4">
          <span className="text-xs text-gray-500 mr-1">tf:</span>
          {RESOLUTIONS.map((r) => (
            <button
              key={r.id}
              onClick={() => setResolution(r.id)}
              className={`px-2 py-1 text-xs rounded ${
                resolution === r.id ? "bg-amber-500 text-black" : "bg-gray-800 hover:bg-gray-700"
              }`}
              data-testid={`spike-tf-${r.label}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 px-4 py-2 border-b border-gray-800 text-xs">
        <Stat label="status" value={status} />
        <Stat label="source" value={source ?? "—"} />
        <Stat label="load ms" value={loadMs == null ? "—" : String(loadMs)} />
        <Stat label="interval" value={`${intervalLabel} (${intervalMs}ms)`} />
        <Stat label="ticks" value={String(tickCount)} />
        <Stat label="last close" value={lastClose == null ? "—" : lastClose.toFixed(2)} />
        <Stat
          label="mark"
          value={markPrice == null ? "—" : `${markPrice.toFixed(2)} (${markTickCount})`}
        />
        <Stat
          label="overlay sync drops"
          value={`${(overlayDiag.dropRatio * 100).toFixed(2)}% (${overlayDiag.syncDrops}/${overlayDiag.syncFrames})`}
        />
        <Stat
          label="levels on/off screen"
          value={`${overlayDiag.levelsRendered} / ${overlayDiag.levelsOffscreen}`}
        />
      </div>

      <div ref={containerRef} className="flex-1 relative" data-testid="spike-chart-container" />

      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-500">
        Pan / zoom the chart. The yellow / red bands are the heatmap overlay
        sync prototype — they should stay locked to their price levels at all
        times. Drop ratio &gt; 5% during steady state means sync is fragile.
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className="text-xs text-gray-200 font-mono">{value}</span>
    </div>
  );
}
