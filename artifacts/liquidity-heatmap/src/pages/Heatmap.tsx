import { Suspense, lazy, useState, useEffect, useRef } from "react";
import { useGetLiquidityHeatmap, type LiquidityHeatmap } from "@workspace/api-client-react";
import { useChannel } from "@/hooks/useChannel";
import { getDatafeed } from "@/datafeed";
import { normalizeSymbolKey, sameSymbolKey } from "@/datafeed/normalize";
import {
  DATAFEED_SHADOW_ENABLED,
  shadowCompare,
} from "@/datafeed/shadow";
import { MarketStatsBar } from "@/components/heatmap/MarketStatsBar";
import {
  HeatmapChart,
  INTERVALS,
  type Interval,
  type HeatmapHighlight,
} from "@/components/heatmap/HeatmapChart";
import { SymbolSearch } from "@/components/heatmap/SymbolSearch";
import { IntervalPicker } from "@/components/heatmap/IntervalPicker";
import { ChartTypePicker } from "@/components/heatmap/ChartTypePicker";
import { DrawingToolbar } from "@/components/heatmap/DrawingToolbar";
import { useUpstreamPressure } from "@/hooks/useUpstreamPressure";
import { useStructuralLevels } from "@/lib/structuralLevels";
import { RangeBar } from "@/components/heatmap/RangeBar";
import { DomLadderPanel } from "@/components/heatmap/DomLadderPanel";
import { useChartSettings } from "@/lib/chartSettings";
import { useSearch, useLocation, Link } from "wouter";
import {
  AlertTriangle, X, LineChart, Scaling, Settings, Activity,
  List, Layers, Bell, Calendar, MessageSquare, Compass, Grid3x3,
} from "lucide-react";

// lazyHeatmapPanelsV1: split non-critical panels from the first chart chunk.
// The visible chart, DOM ladder, Bookmap/heatmap strip, symbol picker, and
// interval controls remain immediate. Secondary panels load only when rendered
// or opened. UI/runtime only; protected engines untouched.
const WatchlistPanel = lazy(() =>
  import("@/components/heatmap/WatchlistPanel").then((m) => ({ default: m.WatchlistPanel })),
);
const IndicatorsModal = lazy(() =>
  import("@/components/heatmap/IndicatorsModal").then((m) => ({ default: m.IndicatorsModal })),
);
const DomAlignmentPanel = lazy(() =>
  import("@/components/heatmap/DomAlignmentPanel").then((m) => ({ default: m.DomAlignmentPanel })),
);

function PanelFallback({ label = "LOADING PANEL..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center min-w-[180px] h-full bg-card text-[10px] font-mono text-muted-foreground animate-pulse">
      {label}
    </div>
  );
}

// Per-user platform-state keys. Writes under the `thermal.*` namespace
// are auto-mirrored to the `user_preferences` row by the
// `lib/preferenceSync` interceptor and rehydrated on the next login.
// All values stored as JSON.stringify of a plain string.
const SYMBOL_KEY = "thermal.heatmap.symbol.v1";
const INTERVAL_KEY = "thermal.heatmap.interval.v1";
const RIGHT_VIEW_KEY = "thermal.heatmap.rightView.v1";

function readPersistedString(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    // Backwards-compat: tolerate plain strings written before the
    // JSON-string contract existed (defensive — no producer in tree).
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

function writePersistedString(key: string, value: string): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function getInitialSymbol(): string {
  // URL `?symbol=` always wins so deep-links from the scanner still work
  // — only fall back to the user's last-used symbol when no URL hint.
  try {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get("symbol");
    if (sym) return sym;
  } catch {}
  const persisted = readPersistedString(SYMBOL_KEY);
  if (persisted) return persisted;
  return "BTC-USDT";
}

function getInitialInterval(): Interval {
  const persisted = readPersistedString(INTERVAL_KEY);
  // Validate against the canonical Interval union (re-exported from
  // HeatmapChart as `INTERVALS`) — never trust a stale or hand-edited
  // localStorage value to short-circuit type safety. Importing the
  // single source of truth means we can never drift from it the way
  // a hardcoded subset would.
  if (persisted && (INTERVALS as readonly string[]).includes(persisted)) {
    return persisted as Interval;
  }
  return "4H";
}

function getInitialRightView(): "watchlist" | "screener" {
  const persisted = readPersistedString(RIGHT_VIEW_KEY);
  return persisted === "screener" ? "screener" : "watchlist";
}

function parseHighlight(params: URLSearchParams): HeatmapHighlight | null {
  const lo = parseFloat(params.get("hlLow") ?? "");
  const hi = parseFloat(params.get("hlHigh") ?? "");
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const priceLow = Math.min(lo, hi);
  const priceHigh = Math.max(lo, hi);
  const midRaw = parseFloat(params.get("hlMid") ?? "");
  const midPrice = Number.isFinite(midRaw) ? midRaw : (priceLow + priceHigh) / 2;
  return {
    priceLow,
    priceHigh,
    midPrice,
    source: params.get("hlSrc") ?? undefined,
    kind: params.get("hlKind") ?? undefined,
    timeframe: params.get("hlTf") ?? undefined,
  };
}

function getInitialHighlight(): HeatmapHighlight | null {
  try {
    return parseHighlight(new URLSearchParams(window.location.search));
  } catch {
    return null;
  }
}

export default function Heatmap() {
  const search = useSearch();
  const [symbol, setSymbolState] = useState(getInitialSymbol);
  const [highlight, setHighlight] = useState<HeatmapHighlight | null>(getInitialHighlight);
  // Wrap setSymbol so manual symbol changes (search box, watchlist click)
  // also drop any in-flight scanner highlight — it would just be misleading
  // on a different chart.
  const setSymbol = (s: string) => {
    setSymbolState((prev) => {
      if (prev !== s) setHighlight(null);
      return s;
    });
  };
  const [showRekt, setShowRekt] = useState(false);
  const [rightView, setRightView] = useState<"watchlist" | "screener">(getInitialRightView);
  const [rightViewKey, setRightViewKey] = useState(0);
  // Persist the right-panel choice under the user's prefs. Mirror layer
  // picks this up automatically from the `thermal.*` namespace.
  useEffect(() => { writePersistedString(RIGHT_VIEW_KEY, rightView); }, [rightView]);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  // DOM/level alignment diagnostic. Strictly read-only — surfaces how
  // well live order-book walls line up with our registry levels. Off by
  // default to keep the chart uncluttered.
  const [domAlignOpen, setDomAlignOpen] = useState(false);
  const { settings, set, update, openTo } = useChartSettings();
  const SCALE_CYCLE: Array<"auto" | "regular" | "log"> = ["auto", "regular", "log"];
  const SCALE_LABEL: Record<string, string> = { auto: "AUTO", regular: "REG", log: "LOG", percent: "%" };
  const cycleScale = () => {
    const cur = settings.canvas.priceScaleMode ?? "auto";
    const idx = SCALE_CYCLE.indexOf(cur as any);
    const next = SCALE_CYCLE[(idx + 1) % SCALE_CYCLE.length];
    update("canvas", { priceScaleMode: next });
  };

  useEffect(() => {
    const params = new URLSearchParams(search);
    const sym = params.get("symbol");
    const next = parseHighlight(params);
    if (sym && !sameSymbolKey(sym, symbol)) {
      setSymbolState(sym);
    }
    setHighlight(next);
  }, [search]);
  // Persist the active symbol so the next session opens on it. The URL
  // `?symbol=` query still wins on cold-load (see getInitialSymbol).
  useEffect(() => { writePersistedString(SYMBOL_KEY, symbol); }, [symbol]);
  // timeframeSwitchDebounceV1: keep the picker UI immediate, but debounce the
  // chart/data interval commit so rapid mobile taps do not start a separate
  // candle + levels request pair for every intermediate timeframe. This is
  // transport/UI scheduling only; level formulas and engine outputs are untouched.
  const [requestedInterval, setRequestedInterval] = useState<Interval>(getInitialInterval);
  const [interval, setActiveInterval] = useState<Interval>(requestedInterval);
  const intervalCommitTimerRef = useRef<number | null>(null);
  const setInterval = (next: Interval) => {
    setRequestedInterval(next);
    if (intervalCommitTimerRef.current != null) {
      window.clearTimeout(intervalCommitTimerRef.current);
    }
    const delayMs = Math.max(
      120,
      Number(import.meta.env.VITE_TIMEFRAME_SWITCH_DEBOUNCE_MS ?? "220") || 220,
    );
    intervalCommitTimerRef.current = window.setTimeout(() => {
      intervalCommitTimerRef.current = null;
      setActiveInterval(next);
    }, delayMs);
  };
  useEffect(() => {
    return () => {
      if (intervalCommitTimerRef.current != null) {
        window.clearTimeout(intervalCommitTimerRef.current);
        intervalCommitTimerRef.current = null;
      }
    };
  }, []);
  // Persist the user's selected interval immediately, while network-heavy chart
  // consumers receive the debounced active interval above.
  useEffect(() => { writePersistedString(INTERVAL_KEY, requestedInterval); }, [requestedInterval]);
  const [requestedBars, setRequestedBars] = useState<number>(0);
  const [, navigate] = useLocation();

  // Subscribe to the structural-levels feed purely so the toolbar can
  // surface the active candle source. We mirror the chart canvas's own
  // `enabled` (settings.structuralLevels.enabled) so this never causes
  // /api/levels polling on its own — when structural levels are off,
  // the toolbar pill simply stays hidden. When they're on, the hook's
  // registry de-dupes across components and we share the same
  // in-flight request the chart already drives, so no extra HTTP.
  const { dataSource: candleSource } = useStructuralLevels({
    symbol,
    interval,
    enabled: !!settings.structuralLevels?.enabled,
  });

  // REST is the cold-start fetch only — once the WS channel pushes a tick
  // the heatmap follows the live stream. This eliminates the old 3s
  // polling interval (now disabled) without losing the initial-render
  // payload that gates the loading screen.
  const { data: apiData, isLoading, isError } = useGetLiquidityHeatmap(
    { symbol, levels: 150 },
    { query: { refetchInterval: false, staleTime: 30_000 } }
  );

  // The WS heatmap delta only carries fields that change tick-to-tick
  // (markPrice, levels, exchange, updatedAt). Rollup fields like
  // priceChange24h / openInterest / fundingRate / volume24h are slow and
  // continue to come from the REST snapshot (refreshed every 30s). We
  // therefore MERGE the WS payload over the REST payload so consumers
  // (e.g. MarketStatsBar) always see a complete object — never a
  // partial payload that would crash `.toFixed`.
  const [liveDelta, setLiveDelta] = useState<Partial<LiquidityHeatmap> | null>(null);
  const liveDeltaRafRef = useRef<number | null>(null);
  const pendingLiveDeltaRef = useRef<Partial<LiquidityHeatmap> | null>(null);
  useEffect(() => {
    setLiveDelta(null);
    pendingLiveDeltaRef.current = null;
    if (liveDeltaRafRef.current != null) {
      window.cancelAnimationFrame(liveDeltaRafRef.current);
      liveDeltaRafRef.current = null;
    }
  }, [symbol]);
  useEffect(() => () => {
    if (liveDeltaRafRef.current != null) {
      window.cancelAnimationFrame(liveDeltaRafRef.current);
      liveDeltaRafRef.current = null;
    }
  }, []);
  const wsSymbol = normalizeSymbolKey(symbol);
  useChannel<Partial<LiquidityHeatmap>>(`heatmap:${wsSymbol}`, (payload) => {
    if (!payload || typeof payload !== "object") return;
    pendingLiveDeltaRef.current = payload;
    if (liveDeltaRafRef.current != null) return;
    liveDeltaRafRef.current = window.requestAnimationFrame(() => {
      liveDeltaRafRef.current = null;
      const next = pendingLiveDeltaRef.current;
      pendingLiveDeltaRef.current = null;
      if (next) setLiveDelta(next);
    });
  });

  // Phase 3 / T125 shadow: parallel `subscribeMark` via the IDatafeed.
  // The legacy `useChannel` above continues to drive consumer state;
  // this side-channel only cross-checks markPrice on each datafeed
  // emission and logs `[datafeed-mismatch] mark:<SYM>:price` on
  // *meaningful* disagreement.
  //
  // Why a generous tolerance? The legacy `useChannel` and the IDatafeed
  // each open their own WebSocket and each subscribes independently to
  // `heatmap:<SYM>` on the api-server hub. The hub fans every delta out
  // to every subscriber, but the two sockets receive ticks at slightly
  // different times because the OS / network / browser do not deliver
  // them in lockstep. The result is that "primary" and "legacy" can be
  // one or two ticks apart at any instant — perfectly healthy live
  // streaming, but raw equality flags it as a mismatch on every move.
  // We use a 25-bps relative tolerance (covers ~ $19 on $77k BTC,
  // ~$0.0125 on $0.50 APE) which is far above normal tick-to-tick
  // drift but still tight enough to surface a real source disagreement
  // (different exchange, mark-vs-last, stale feed, etc.). We also
  // require the legacy baseline to have updated within the last
  // STALE_BASELINE_MS window — if useChannel hasn't emitted recently,
  // the comparison is meaningless because the "legacy" value is just
  // the last cached snapshot and is virtually guaranteed to disagree
  // with a fresh tick. Engine math is untouched: this is purely a
  // shadow-observability tweak.
  const TOL_BPS = 25;
  // Tightened from 5_000 → 1_500 (April 2026). The 5s window admitted
  // false-positive mismatches on low-volume tokens (APE, etc.) where
  // the price can legitimately drift more than the 25-bps tolerance
  // across cross-tick latency between the two parallel WebSocket
  // subscriptions. Both subscriptions read from the same server-side
  // hub channel, so 1.5s is a generous-but-meaningful "both ticks
  // arrived recently" guard. Healthy ticks fire every 100-1000ms;
  // this only suppresses comparisons where the legacy baseline is
  // more than ~3 normal tick intervals old. Engine math untouched.
  const STALE_BASELINE_MS = 1_500;
  type MarkSample = { price: number; ts: number };
  const lastLegacyMarkRef = useRef<MarkSample | null>(null);
  // Reset legacy baseline on symbol switch so the first datafeed tick
  // for the *new* symbol is never compared against the *old* symbol's
  // mark price (which would log a guaranteed-but-meaningless mismatch).
  useEffect(() => {
    lastLegacyMarkRef.current = null;
  }, [wsSymbol]);
  useEffect(() => {
    const m = liveDelta?.markPrice;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) {
      lastLegacyMarkRef.current = { price: m, ts: Date.now() };
    }
  }, [liveDelta]);
  useEffect(() => {
    if (!wsSymbol || !DATAFEED_SHADOW_ENABLED) return;
    const sub = getDatafeed().subscribeMark(wsSymbol, (tick) => {
      const baseline = lastLegacyMarkRef.current;
      // Suppress until the legacy useChannel has emitted at least once
      // for the current symbol — guarantees like-for-like comparison.
      if (!baseline || baseline.price <= 0) return;
      // Suppress when the legacy baseline is too stale to be a fair
      // comparator (either useChannel just hasn't ticked recently, or
      // the page has been backgrounded). The chart price still tracks
      // the legacy stream; this only avoids noisy false-positives.
      if (Date.now() - baseline.ts > STALE_BASELINE_MS) return;
      shadowCompare(
        `mark:${wsSymbol}:price`,
        tick.markPrice,
        baseline.price,
        (a, b) =>
          Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < TOL_BPS / 10_000,
      );
    });
    return () => sub.unsubscribe();
  }, [wsSymbol]);

  // Real-only: when the API server has nothing yet (cold start) or is
  // returning 503 (no live exchange data for this symbol), we leave
  // `data` undefined and the chart canvas renders an honest empty state
  // rather than a fabricated heatmap from a hard-coded base price.
  const data = apiData && liveDelta
    ? ({ ...apiData, ...liveDelta } as LiquidityHeatmap)
    : apiData;

  // The header chip used to surface the *book/heatmap* exchange, which
  // led to a confusing UX: the visible chart price could be coming from
  // a different venue than the chip implied. We now surface the venue
  // that actually feeds the live price + axis label + forming bar
  // (priceSource), and only fall back to the legacy `exchange` field
  // during cold-start ticks before the new contract has populated.
  const priceSource = data?.priceSource ?? null;
  const priceSourceLabel =
    priceSource === "hyperliquid" ? "Hyperliquid"
    : priceSource === "toobit" ? "Toobit"
    : priceSource === "okx" ? "OKX"
    : (data?.exchange ?? "live");
  // HL is the primary so anything else is a price-source fallback worth
  // calling out explicitly (matches how the Toobit candle-fallback pill
  // already calls out a candle-source fallback).
  const priceSourceFallback = !!priceSource && priceSource !== "hyperliquid";
  const noLiveData = isError && !data;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <div className="relative z-30 flex flex-wrap items-center gap-2 sm:gap-4 px-2 sm:px-4 py-2 border-b border-border bg-card shrink-0">
        <SymbolSearch value={symbol} onChange={setSymbol} />

        <IntervalPicker value={requestedInterval} onChange={setInterval} />

        <ChartTypePicker
          value={settings.chartType}
          onChange={(t) => set("chartType", t)}
        />

        <button
          onClick={cycleScale}
          className="flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono bg-accent border border-border rounded-md text-muted-foreground hover:text-foreground shrink-0"
          title="Toggle price scale mode (auto / regular / log)"
          data-testid="toggle-scale-mode"
        >
          <Scaling className="w-3.5 h-3.5" />
          <span className="hidden sm:inline tabular-nums">
            {SCALE_LABEL[settings.canvas.priceScaleMode ?? "auto"]}
          </span>
        </button>

        <button
          onClick={() => setIndicatorsOpen(true)}
          className="flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono bg-accent border border-border rounded-md text-muted-foreground hover:text-foreground shrink-0"
          data-testid="open-indicators"
        >
          <LineChart className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Indicators</span>
          {settings.indicators.length > 0 && (
            <span className="px-1 rounded bg-cyan-500/20 text-cyan-400 text-[10px]">
              {settings.indicators.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setDomAlignOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono border rounded-md shrink-0 ${
            domAlignOpen
              ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
              : "bg-accent border-border text-muted-foreground hover:text-foreground"
          }`}
          data-testid="toggle-dom-align"
          aria-pressed={domAlignOpen}
          title="Compare live DOM walls against our structural / liquidity levels (read-only diagnostic)"
        >
          <Activity className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">DOM Align</span>
        </button>

        <div
          className={`flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono border rounded-md shrink-0 ${
            noLiveData
              ? "bg-accent border-border text-muted-foreground"
              : priceSourceFallback
                ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                : "bg-accent border-border text-muted-foreground"
          }`}
          title={
            noLiveData
              ? "No live data for this symbol on any venue"
              : priceSourceFallback
                ? `Hyperliquid price feed unavailable — serving live price from ${priceSourceLabel}`
                : `Live price feed source: ${priceSourceLabel}`
          }
          data-testid="price-source-chip"
          data-price-source={priceSource ?? "unknown"}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              noLiveData
                ? "bg-rose-400"
                : priceSourceFallback
                  ? "bg-amber-400"
                  : "bg-emerald-400"
            }`}
          />
          <span className="hidden sm:inline">
            {noLiveData ? "NO LIVE DATA" : String(priceSourceLabel).toUpperCase()}
          </span>
          <span className="sm:hidden">
            {noLiveData ? "OFF" : String(priceSourceLabel).toUpperCase().slice(0, 3)}
          </span>
          <UpstreamPressureDot />
        </div>

        {/* Toobit-fallback indicator: only renders when the API server's
            transparent fallback kicked in (HL was empty/null/429/5xx
            for this symbol). Hidden during normal HL service so the
            toolbar stays uncluttered. Disappears automatically the next
            polling cycle after HL recovers. */}
        {candleSource === "toobit" && (
          <div
            className="flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono bg-amber-500/10 border border-amber-500/40 rounded-md text-amber-300 shrink-0"
            title="Hyperliquid candles unavailable — serving bars from Toobit fallback"
            data-testid="candle-source-toobit"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>Toobit</span>
          </div>
        )}

        <button
          onClick={() => openTo("symbol")}
          className="xl:hidden flex items-center gap-1.5 px-2 sm:px-3 h-8 text-xs font-mono bg-accent border border-border rounded-md text-muted-foreground hover:text-foreground shrink-0"
          aria-label="Open chart settings"
          data-testid="open-chart-settings-mobile"
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Settings</span>
        </button>

        <button
          onClick={() => setShowRekt(true)}
          className="ml-auto md:hidden flex items-center gap-1.5 px-2 h-8 text-xs font-mono bg-accent border border-border rounded-md text-orange-400 shrink-0"
          aria-label="Show liquidations"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          REKT
        </button>
      </div>

      <MarketStatsBar data={data ?? null} />

      <div className="flex flex-1 overflow-hidden relative">
        <DrawingToolbar symbol={symbol} interval={interval} />
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <div className="flex flex-1 min-h-0 min-w-0">
            {/*
              Slim Bookmap-style DOM ladder + liquidity heatmap strip.
              Display-only — reads the same heatmap:<symbol> WS channel
              the chart already subscribes to (pub/sub fan-out) plus
              the chart's published price-axis snapshot so its rows
              line up exactly with the chart's price grid. Hidden on
              mobile to keep the chart dominant.
            */}
            <DomLadderPanel symbol={symbol} coldStart={data ?? null} />
            <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
              <HeatmapChart
                data={data ?? null}
                isLoading={isLoading}
                symbol={symbol}
                interval={interval}
                requestVisibleBars={requestedBars}
                highlight={highlight}
                onDismissHighlight={() => setHighlight(null)}
              />
              {/*
                DOM/level alignment diagnostic — toggleable read-only
                overlay. Compares strongest live DOM walls against the
                registry levels. Strict guardrail: never feeds anything
                back into engines (see DomAlignmentPanel.tsx header).
              */}
              {domAlignOpen && (
                <Suspense fallback={<PanelFallback label="LOADING DOM ALIGN..." />}>
                  <DomAlignmentPanel
                    symbol={symbol}
                    onClose={() => setDomAlignOpen(false)}
                  />
                </Suspense>
              )}
            </div>
          </div>
          <RangeBar
            interval={interval}
            onZoomToRange={(bars) => setRequestedBars(bars + Math.random() * 0.0001)}
          />
        </div>
        <div className="hidden md:flex">
          <Suspense fallback={<PanelFallback label="LOADING WATCHLIST..." />}>
            <WatchlistPanel
              key={rightViewKey}
              symbol={symbol}
              onSelectSymbol={setSymbol}
              initialView={rightView}
            />
          </Suspense>
        </div>
        <div className="hidden xl:flex flex-col items-center gap-1 py-2 px-1 border-l border-border bg-card shrink-0">
          {[
            { Icon: List, label: "Watchlist", onClick: () => { setRightView("watchlist"); setRightViewKey((k) => k + 1); } },
            { Icon: Layers, label: "Object tree", onClick: () => openTo("statusLine") },
            { Icon: MessageSquare, label: "Chat", onClick: () => window.alert("Chat panel — coming soon") },
            { Icon: Compass, label: "Screener", onClick: () => { setRightView("screener"); setRightViewKey((k) => k + 1); } },
            { Icon: Bell, label: "Alerts", onClick: () => openTo("alerts") },
            { Icon: Calendar, label: "Events", onClick: () => openTo("events") },
            { Icon: Grid3x3, label: "Indicators", onClick: () => setIndicatorsOpen(true) },
          ].map(({ Icon, label, onClick }) => (
            <button
              key={label}
              title={label}
              onClick={onClick}
              className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>

        {showRekt && (
          <div className="md:hidden absolute inset-0 z-30 flex">
            <div
              className="flex-1 bg-black/60 backdrop-blur-sm"
              onClick={() => setShowRekt(false)}
            />
            <div className="relative flex flex-col">
              <button
                onClick={() => setShowRekt(false)}
                className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded bg-accent border border-border text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
              <Suspense fallback={<PanelFallback label="LOADING WATCHLIST..." />}>
                <Suspense fallback={<PanelFallback label="LOADING WATCHLIST..." />}>
                <WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} />
              </Suspense>
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {indicatorsOpen && (
        <Suspense fallback={null}>
          <IndicatorsModal
            open={indicatorsOpen}
            onClose={() => setIndicatorsOpen(false)}
            active={settings.indicators}
            onAdd={(inst) => set("indicators", [...settings.indicators, inst])}
            onRemove={(id) =>
              set("indicators", settings.indicators.filter((x) => x.id !== id))
            }
          />
        </Suspense>
      )}
    </div>
  );
}

function UpstreamPressureDot() {
  const pressure = useUpstreamPressure();
  const hl = pressure?.hyperliquid;
  const rateLimited = !!hl?.rateLimited;
  // "Elevated" = the limiter is currently making requests wait, or we've
  // absorbed a few 429s recently, even if we're not in active cooldown.
  // These thresholds are deliberately gentle: the dot's job is to warn
  // before charts visibly stall, not to wait until they already have.
  const tokensWaiting = hl?.tokensWaiting ?? 0;
  const avgWait = hl?.avgWaitMs5m ?? 0;
  const recent429s = hl?.count429_5m ?? 0;
  const elevated = !rateLimited && (tokensWaiting > 0 || avgWait > 50 || recent429s > 0);
  const state: "ok" | "elevated" | "limited" = rateLimited
    ? "limited"
    : elevated
      ? "elevated"
      : "ok";
  const seconds = rateLimited ? Math.max(1, Math.ceil((hl?.cooldownMsRemaining ?? 0) / 1000)) : 0;
  const title = (() => {
    if (state === "limited") {
      return `Hyperliquid is rate-limiting us — easing for ${seconds}s (${recent429s} 429s in last 5m, avg wait ${avgWait}ms)`;
    }
    if (state === "elevated") {
      return `Upstream pressure elevated — ${tokensWaiting} request(s) queued, avg wait ${avgWait}ms, ${recent429s} 429s in last 5m`;
    }
    if (hl) {
      return `Upstream healthy — avg wait ${avgWait}ms over last 5m`;
    }
    return "Upstream healthy";
  })();
  const cls =
    state === "limited"
      ? "bg-amber-400 animate-pulse"
      : state === "elevated"
        ? "bg-yellow-400"
        : "bg-emerald-500/50";
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`}
      title={title}
      data-testid="upstream-pressure-dot"
      data-pressure-state={state}
      aria-label={title}
    />
  );
}
