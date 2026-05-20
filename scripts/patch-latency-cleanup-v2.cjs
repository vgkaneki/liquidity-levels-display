const fs = require('fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, src) { fs.writeFileSync(file, src); }
function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[latency-cleanup-v2] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[latency-cleanup-v2] skipped ${label}`);
    return src;
  }
  console.log(`[latency-cleanup-v2] applied ${label}`);
  return src.replace(find, replace);
}
function replaceAll(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[latency-cleanup-v2] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[latency-cleanup-v2] skipped ${label}`);
    return src;
  }
  console.log(`[latency-cleanup-v2] applied ${label}`);
  return src.split(find).join(replace);
}

// latencyCleanupV2: transport/render/background workload hardening only.
// Protected liquidity/structural formulas, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, and level placement rules are untouched.

// 1) HeatmapChart: reduce candle retry pressure, add last-good display fallback,
// slower mobile watchdog, and avoid 5s liquidation REST polling.
{
  const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
  let src = read(file);
  src = apply(
    src,
    '} from "@/lib/drawingStore";\n',
    '} from "@/lib/drawingStore";\nimport { candleWatchdogDelayMs, displayCandlesWithFallback, rememberLastGoodCandles } from "@/lib/chartCandleFallback";\n',
    'chartCandleFallback',
    'candle fallback imports',
  );
  src = apply(
    src,
    '        retry: 3,',
    '        // latencyCleanupV2: one retry is enough for transient aborts; more\n        // retries can amplify provider pressure during HL/OKX/Toobit instability.\n        retry: 1,',
    'latencyCleanupV2: one retry',
    'reduce candle retry count',
  );
  src = apply(
    src,
    '    }, 7000);',
    '    }, candleWatchdogDelayMs());',
    'candleWatchdogDelayMs()',
    'mobile-aware candle watchdog',
  );
  src = apply(
    src,
`  const apiCandles = useMemo((): Candle[] | null => {
    if (!candleResponse?.candles?.length) return null;
    return candleResponse.candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: (c as { volume?: number }).volume,
    }));
  }, [candleResponse]);
`,
`  const apiCandles = useMemo((): Candle[] | null => {
    if (!candleResponse?.candles?.length) return null;
    return candleResponse.candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: (c as { volume?: number }).volume,
    }));
  }, [candleResponse]);

  // latencyCleanupV2: display-only last-good fallback. This prevents a blank
  // chart on a transient cold-miss/503 for the same symbol+interval. It never
  // fabricates candles for engines, levels, scoring, or confluence.
  useEffect(() => {
    rememberLastGoodCandles(symbol, interval, apiCandles);
  }, [symbol, interval, apiCandles]);
  const displayApiCandles = useMemo((): Candle[] | null => {
    return displayCandlesWithFallback(symbol, interval, apiCandles, !!candleError) as Candle[] | null;
  }, [symbol, interval, apiCandles, candleError]);
`,
    'display-only last-good fallback',
    'last-good candle fallback state',
  );
  src = apply(
    src,
    '    const allCandles: Candle[] = apiCandles\n      ? updateCandleStore(chartSymbol, data.markPrice, intervalMs, apiCandles)\n      : [];',
    '    const allCandles: Candle[] = displayApiCandles\n      ? updateCandleStore(chartSymbol, data.markPrice, intervalMs, displayApiCandles)\n      : [];',
    'displayApiCandles\n      ? updateCandleStore',
    'use last-good display candle fallback',
  );
  src = apply(
    src,
`  const { data: liquidationEvents } = useGetLiquidations(
    { symbol, limit: 200 },
    { query: { refetchInterval: 5000, staleTime: 4000, enabled: !!symbol } }
  );
`,
`  // latencyCleanupV2: real liquidation events stay available, but the focused
  // chart should not poll this REST endpoint every 5s while candles/levels are
  // also loading. Indicator-specific liquidation clusters are separately gated.
  const { data: liquidationEvents } = useGetLiquidations(
    { symbol, limit: 200 },
    {
      query: {
        refetchInterval: 30000,
        staleTime: 25000,
        retry: 0,
        refetchOnWindowFocus: false,
        enabled: !!symbol,
      },
    }
  );
`,
    'latencyCleanupV2: real liquidation events',
    'slow liquidation REST polling',
  );
  write(file, src);
}

// 2) Upstream pressure polling: reduce per-tab noise.
{
  const file = 'artifacts/liquidity-heatmap/src/hooks/useUpstreamPressure.ts';
  let src = read(file);
  src = apply(
    src,
    'export function useUpstreamPressure(pollMs = 15_000): UpstreamPressure | null {',
    'export function useUpstreamPressure(pollMs = 30_000): UpstreamPressure | null {',
    'pollMs = 30_000',
    'slow upstream pressure polling',
  );
  write(file, src);
}

// 3) Analytics sampler: demand-gate overlay work and default to 15s buckets.
{
  const file = 'artifacts/api-server/src/routes/liquidity/analytics-store.ts';
  let src = read(file);
  src = apply(
    src,
    'const SAMPLE_INTERVAL_MS = 5_000;\nconst MAX_SAMPLES = 720; // ~1 hour at 5s\n',
    'const SAMPLE_INTERVAL_MS = Math.max(5_000, Number(process.env.ANALYTICS_SAMPLE_INTERVAL_MS ?? "15000") || 15_000);\nconst MAX_SAMPLES = 720;\nconst ANALYTICS_DEMAND_TTL_MS = Math.max(30_000, Number(process.env.ANALYTICS_DEMAND_TTL_MS ?? "120000") || 120_000);\nconst analyticsDemand = new Map<string, number>();\n',
    'ANALYTICS_DEMAND_TTL_MS',
    'demand-gated analytics constants',
  );
  src = apply(
    src,
    'function getState(symbol: string): SymbolState {\n',
    'function markAnalyticsDemand(symbol: string): void {\n  analyticsDemand.set(symbol, Date.now());\n}\n\nfunction demandedSymbols(now: number): string[] {\n  const out: string[] = [];\n  for (const [symbol, ts] of analyticsDemand) {\n    if (now - ts <= ANALYTICS_DEMAND_TTL_MS) out.push(symbol);\n    else analyticsDemand.delete(symbol);\n  }\n  return out;\n}\n\nfunction getState(symbol: string): SymbolState {\n',
    'function demandedSymbols',
    'analytics demand helpers',
  );
  src = apply(
    src,
    '    const symbols = listActive();\n    for (const s of symbols) {',
    '    const symbols = demandedSymbols(now);\n    if (symbols.length === 0) return;\n    for (const s of symbols) {',
    'const symbols = demandedSymbols(now);',
    'sample only demanded analytics symbols',
  );
  src = apply(
    src,
    'export function getAnalytics(symbol: string, windowMs: number): AnalyticsResponse {\n  const state = states.get(symbol);',
    'export function getAnalytics(symbol: string, windowMs: number): AnalyticsResponse {\n  markAnalyticsDemand(symbol);\n  const state = states.get(symbol);',
    'markAnalyticsDemand(symbol);',
    'mark demand when analytics endpoint is used',
  );
  write(file, src);
}

// 4) Market overview: make warm opt-in, cap cold fallback walks, and prioritize majors/live symbols.
{
  const file = 'artifacts/api-server/src/services/marketOverview.ts';
  let src = read(file);
  src = apply(
    src,
    'const WARM_INTERVAL_MS = 25_000; // refresh below CACHE_TTL_MS so it stays hot\n',
    'const WARM_INTERVAL_MS = Math.max(30_000, Number(process.env.MARKET_OVERVIEW_WARM_INTERVAL_MS ?? "60000") || 60_000);\nconst MARKET_OVERVIEW_WARM_ENABLED = process.env.ENABLE_MARKET_OVERVIEW_WARM === "1";\nconst MARKET_OVERVIEW_MAX_INSTRUMENTS = Math.max(10, Number(process.env.MARKET_OVERVIEW_MAX_INSTRUMENTS ?? "80") || 80);\nconst MARKET_OVERVIEW_PRIORITY = new Set(["BTC", "ETH", "SOL", "HYPE", "BNB", "XRP", "DOGE", "LINK", "AVAX", "SUI"]);\n',
    'MARKET_OVERVIEW_MAX_INSTRUMENTS',
    'market overview caps',
  );
  src = apply(
    src,
    'export function startMarketOverviewWarm(): void {\n  if (warmStarted) return;',
    'export function startMarketOverviewWarm(): void {\n  if (!MARKET_OVERVIEW_WARM_ENABLED) return;\n  if (warmStarted) return;',
    'if (!MARKET_OVERVIEW_WARM_ENABLED) return;',
    'make market overview warm opt-in',
  );
  src = apply(
    src,
    '  if (okxInstruments && okxInstruments.length > 0) {\n    const tickerEntries = await Promise.all(\n      okxInstruments.map(async (inst): Promise<MarketOverviewSymbol | null> => {',
    '  if (okxInstruments && okxInstruments.length > 0) {\n    const prioritizedInstruments = [...okxInstruments]\n      .sort((a, b) => {\n        const ap = MARKET_OVERVIEW_PRIORITY.has(a.baseAsset.toUpperCase()) ? 0 : 1;\n        const bp = MARKET_OVERVIEW_PRIORITY.has(b.baseAsset.toUpperCase()) ? 0 : 1;\n        return ap - bp;\n      })\n      .slice(0, MARKET_OVERVIEW_MAX_INSTRUMENTS);\n    const tickerEntries = await Promise.all(\n      prioritizedInstruments.map(async (inst): Promise<MarketOverviewSymbol | null> => {',
    'prioritizedInstruments',
    'cap market overview instrument walk',
  );
  write(file, src);
}

// 5) wsHub: slow market overview rebuilds and stop book updates from forcing rebuild work.
{
  const file = 'artifacts/api-server/src/services/wsHub/index.ts';
  let src = read(file);
  src = apply(
    src,
    'const MARKET_OVERVIEW_INTERVAL_MS = 30_000;\n',
    'const MARKET_OVERVIEW_INTERVAL_MS = Math.max(30_000, Number(process.env.MARKET_OVERVIEW_WS_INTERVAL_MS ?? "60000") || 60_000);\nconst MARKET_OVERVIEW_REBUILD_MIN_MS = Math.max(10_000, Number(process.env.MARKET_OVERVIEW_REBUILD_MIN_MS ?? "20000") || 20_000);\nlet marketOverviewLastRebuildAt = 0;\n',
    'MARKET_OVERVIEW_REBUILD_MIN_MS',
    'market overview rebuild throttle constants',
  );
  src = apply(
    src,
    '  if (!subscribers.has("market:overview")) return;\n  if (marketOverviewPending) return;',
    '  if (!subscribers.has("market:overview")) return;\n  const now = Date.now();\n  if (now - marketOverviewLastRebuildAt < MARKET_OVERVIEW_REBUILD_MIN_MS) return;\n  if (marketOverviewPending) return;\n  marketOverviewLastRebuildAt = now;',
    'marketOverviewLastRebuildAt = now;',
    'throttle market overview rebuilds',
  );
  src = apply(
    src,
    '    // Book updates also move the market overview rollup (volume share\n    // and depth metrics depend on it). Same coalesce keeps us cheap.\n    void symbol;\n    scheduleMarketOverviewRebuild();',
    '    // latencyCleanupV2: book ticks are too frequent for the heavy market\n    // overview aggregate. Ticker events and the slow safety-net interval are\n    // enough; do not let book churn compete with the focused chart.\n    void symbol;',
    'book ticks are too frequent for the heavy market',
    'disable book-driven market overview rebuild',
  );
  write(file, src);
}

// 6) Alert engine: slower reloads, debounce level update evaluation, and queue dispatch work.
{
  const file = 'artifacts/api-server/src/services/alertEngine/index.ts';
  let src = read(file);
  src = apply(
    src,
    'let started = false;\n',
    'let started = false;\nconst ALERT_RULE_RELOAD_MS = Math.max(30_000, Number(process.env.ALERT_RULE_RELOAD_MS ?? "45000") || 45_000);\nconst ALERT_LEVEL_EVAL_DEBOUNCE_MS = Math.max(250, Number(process.env.ALERT_LEVEL_EVAL_DEBOUNCE_MS ?? "750") || 750);\nconst ALERT_DISPATCH_CONCURRENCY = Math.max(1, Number(process.env.ALERT_DISPATCH_CONCURRENCY ?? "3") || 3);\nlet alertDispatchActive = 0;\nconst alertDispatchQueue: Array<() => Promise<void>> = [];\nconst pendingLevelEval = new Map<string, NodeJS.Timeout>();\n\nfunction runAlertQueue(): void {\n  while (alertDispatchActive < ALERT_DISPATCH_CONCURRENCY && alertDispatchQueue.length > 0) {\n    const task = alertDispatchQueue.shift()!;\n    alertDispatchActive += 1;\n    void task().finally(() => {\n      alertDispatchActive -= 1;\n      runAlertQueue();\n    });\n  }\n}\n\nfunction enqueueAlertDispatch(task: () => Promise<void>): void {\n  alertDispatchQueue.push(task);\n  runAlertQueue();\n}\n',
    'ALERT_DISPATCH_CONCURRENCY',
    'alert cadence and queue constants',
  );
  src = apply(
    src,
    'async function dispatch(rule: AlertRule, message: string, payload: Record<string, unknown>, price: number, firedSymbol?: string): Promise<void> {',
    'async function dispatchNow(rule: AlertRule, message: string, payload: Record<string, unknown>, price: number, firedSymbol?: string): Promise<void> {',
    'dispatchNow(rule',
    'rename dispatch implementation',
  );
  src = apply(
    src,
    '// ─────────────────────────── evaluation ───────────────────────────\n',
    'async function dispatch(rule: AlertRule, message: string, payload: Record<string, unknown>, price: number, firedSymbol?: string): Promise<void> {\n  enqueueAlertDispatch(() => dispatchNow(rule, message, payload, price, firedSymbol));\n}\n\n// ─────────────────────────── evaluation ───────────────────────────\n',
    'enqueueAlertDispatch(() => dispatchNow',
    'queued dispatch wrapper',
  );
  src = apply(
    src,
    '  setInterval(() => void reloadRules(), 10_000);',
    '  setInterval(() => void reloadRules(), ALERT_RULE_RELOAD_MS);',
    'ALERT_RULE_RELOAD_MS',
    'slow alert rule reload cadence',
  );
  src = apply(
    src,
`  levelRegistry.onUpdate((symbol, levels) => {
    evaluateOnLevels(symbol, levels);
  });
`,
`  levelRegistry.onUpdate((symbol, levels) => {
    const existing = pendingLevelEval.get(symbol);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingLevelEval.delete(symbol);
      evaluateOnLevels(symbol, levels);
    }, ALERT_LEVEL_EVAL_DEBOUNCE_MS);
    pendingLevelEval.set(symbol, timer);
  });
`,
    'pendingLevelEval.set(symbol, timer)',
    'debounce level alert evaluation',
  );
  write(file, src);
}

// 7) Candle route: clamp expensive foreground cold-miss fetches by interval.
// The client may ask for 1800 bars while rapidly switching 1D/3D/1W/1M/12H.
// On a cold cache that becomes a huge provider lookback and was producing
// 5-7s waits, aborted requests, HL 429s, and level skeletons. This is a
// transport-only cap: the chart still renders real candles, just fewer bars
// on cold high-timeframe first paint. Engines/formulas/level placement are untouched.
{
  const file = 'artifacts/api-server/src/routes/liquidity/index.ts';
  let src = read(file);
  src = apply(
    src,
    'const candleInflight = new Map<string, Promise<CandleComputeOutcome>>();\n',
    'const candleInflight = new Map<string, Promise<CandleComputeOutcome>>();\n\nfunction clampCandleLimitForPressure(bar: string, requested: number): number {\n  // foregroundCandlePressureV1\n  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 200;\n  const envOverride = Number(process.env.CANDLE_FOREGROUND_MAX_BARS ?? "0");\n  if (Number.isFinite(envOverride) && envOverride > 0) {\n    return Math.min(safeRequested, Math.max(50, Math.floor(envOverride)));\n  }\n  const upper = bar === "1M" ? 120\n    : bar === "1W" ? 180\n    : bar === "3D" ? 220\n    : bar === "1D" ? 260\n    : bar === "12H" ? 320\n    : bar === "6H" ? 420\n    : bar === "4H" ? 520\n    : bar === "2H" ? 650\n    : bar === "1H" ? 800\n    : bar === "30m" ? 900\n    : bar === "15m" ? 1_000\n    : 1_200;\n  return Math.min(safeRequested, upper);\n}\n',
    'foregroundCandlePressureV1',
    'foreground candle interval cap helper',
  );
  src = apply(
    src,
    '  const lim = Number(limit);\n',
    '  const requestedLim = Number(limit);\n  const lim = clampCandleLimitForPressure(bar, requestedLim);\n',
    'const requestedLim = Number(limit);',
    'clamp foreground candle request limit',
  );
  src = apply(
    src,
    '    res.setHeader("X-Cache", "HIT");',
    '    res.setHeader("X-Cache", "HIT");\n    res.setHeader("X-Candles-Limit", String(lim));',
    'X-Candles-Limit',
    'emit candle limit header',
  );
  write(file, src);
}

console.log('[latency-cleanup-v2] complete');
