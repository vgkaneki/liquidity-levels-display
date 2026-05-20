const fs = require('fs');

const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[timeframe-switch-performance-patch] already applied ${label}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[timeframe-switch-performance-patch] skipped ${label}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[timeframe-switch-performance-patch] applied ${label}`);
}

function remove(find, label) {
  if (!src.includes(find)) {
    console.log(`[timeframe-switch-performance-patch] skipped ${label}`);
    return;
  }
  src = src.replace(find, '');
  console.log(`[timeframe-switch-performance-patch] removed ${label}`);
}

apply(
  'import { useStructuralLevels, structuralZoneColor } from "@/lib/structuralLevels";',
  'import { useStructuralLevels, prefetchStructuralLevels, structuralZoneColor } from "@/lib/structuralLevels";',
  'prefetchStructuralLevels',
  'structural prefetch import',
);

apply(
  'import { runChartPlugins } from "@/lib/chartPlugins";',
  'import { runChartPlugins } from "@/lib/chartPlugins";\nimport { apiUrl } from "@/lib/api";',
  'import { apiUrl } from "@/lib/api";',
  'apiUrl import',
);

const helperBlock = [
  '// timeframeSwitchPerfV1: chart timeframe switching should paint quickly.',
  '// Keep protected engine lookback untouched; only reduce the first visual candle',
  '// request, then lazily expand history after the chart is already usable.',
  'const FULL_CANDLE_HISTORY_LIMIT = 10000;',
  'const FAST_CANDLE_LIMIT_BY_INTERVAL: Record<string, number> = {',
  '  "1m": 900,',
  '  "3m": 1000,',
  '  "5m": 1200,',
  '  "15m": 1500,',
  '  "30m": 1600,',
  '  "1H": 1800,',
  '  "2H": 1800,',
  '  "4H": 1800,',
  '  "6H": 1600,',
  '  "12H": 1500,',
  '  "1D": 1200,',
  '  "3D": 900,',
  '  "1W": 700,',
  '  "1M": 500,',
  '};',
  '',
  'function fastCandleLimitForInterval(interval: string): number {',
  '  return FAST_CANDLE_LIMIT_BY_INTERVAL[interval] ?? 1500;',
  '}',
  '',
  'function adjacentIntervalsForPrefetch(interval: Interval): Interval[] {',
  '  const idx = INTERVALS.indexOf(interval);',
  '  if (idx < 0) return [];',
  '  const out: Interval[] = [];',
  '  const prev = INTERVALS[idx - 1];',
  '  const next = INTERVALS[idx + 1];',
  '  if (prev) out.push(prev);',
  '  if (next) out.push(next);',
  '  return out;',
  '}',
].join('\n');

apply(
  'const V_ZOOM_MAX = 50;\n',
  `const V_ZOOM_MAX = 50;\n\n${helperBlock}\n`,
  'timeframeSwitchPerfV1',
  'timeframe switch helpers',
);

const oldLimitBlock = [
  '  // Same max history depth (10000 bars) on every interval — matches the user',
  '  // expectation that zoom-out distance is uniform across timeframes. The API',
  '  // schema cap is 10000.',
  '  const candleLimit = 10000;',
].join('\n');

const newLimitBlock = [
  '  // timeframeSwitchPerfV1: fast-first visual candle loading. On symbol or',
  '  // interval change, request a compact candle set first so the chart paints',
  '  // quickly. After a short idle delay, expand to the full 10k visual history.',
  '  // Protected engine lookback, scoring, confluence, DOM, Bookmap, absorption,',
  '  // and touch classification remain untouched.',
  '  const intervalKey = `${normalizeSymbolKey(symbol)}|${interval}`;',
  '  const [historyDepthState, setHistoryDepthState] = useState<{ key: string; expanded: boolean }>(() => ({',
  '    key: intervalKey,',
  '    expanded: false,',
  '  }));',
  '  const expandedHistory = historyDepthState.key === intervalKey && historyDepthState.expanded;',
  '  const candleLimit = expandedHistory',
  '    ? FULL_CANDLE_HISTORY_LIMIT',
  '    : fastCandleLimitForInterval(interval);',
  '',
  '  useEffect(() => {',
  '    setHistoryDepthState({ key: intervalKey, expanded: false });',
  '    const delayMs = Math.max(',
  '      0,',
  '      Number(import.meta.env.VITE_FULL_CANDLE_HISTORY_DELAY_MS ?? "1800") || 1_800,',
  '    );',
  '    const timer = window.setTimeout(() => {',
  '      setHistoryDepthState((cur) =>',
  '        cur.key === intervalKey ? { key: intervalKey, expanded: true } : cur,',
  '      );',
  '    }, delayMs);',
  '    return () => window.clearTimeout(timer);',
  '  }, [intervalKey]);',
].join('\n');

apply(
  oldLimitBlock,
  newLimitBlock,
  'fast-first visual candle loading',
  'fast-first candle limit',
);

// timeframeSwitchPerfV2: do NOT use React Query placeholderData for candle
// queries. It can temporarily display the previous symbol/interval candles
// against the new symbol's live mark price, causing the chart to squash to the
// top/bottom before returning to normal. Let the chart show its normal loading
// state until matching candles arrive.
remove(
  '        // timeframeSwitchPerfV1: keep the last painted candles on screen while\n        // the next interval/history request is loading. Do not reference\n        // expandedHistory here because patch-fast-page-load may own the\n        // candleLimit state before this patch runs.\n        placeholderData: (previousData: any) => previousData,\n',
  'unsafe candle placeholderData',
);
remove(
  '        placeholderData: expandedHistory ? ((previousData: any) => previousData) : undefined,\n',
  'old expandedHistory placeholderData',
);

apply(
  '  const { data: liquidationEvents } = useGetLiquidations(\n    { symbol, limit: 200 },\n    { query: { refetchInterval: 5000, staleTime: 4000, enabled: !!symbol } }\n  );',
  '  // networkQuietV1: liquidation events are useful, but polling them every\n  // 5s during rapid interval switching was visible in the network logs as a\n  // repeated /liquidations?limit=200 stream. Keep the data, but slow the REST\n  // cadence and avoid retry/window-focus bursts. UI transport only; engines\n  // and liquidation math are untouched.\n  const { data: liquidationEvents } = useGetLiquidations(\n    { symbol, limit: 200 },\n    {\n      query: {\n        refetchInterval: 30000,\n        staleTime: 25000,\n        retry: 0,\n        refetchOnWindowFocus: false,\n        enabled: !!symbol,\n      },\n    }\n  );',
  'networkQuietV1',
  'throttle chart liquidation REST polling',
);

const prefetchEffect = [
  '  // timeframeSwitchPerfV1: adjacent timeframe prefetch is now opt-in.',
  '  // The mobile network trace showed rapid timeframe sweeps creating extra',
  '  // background /candles and /levels calls for neighboring intervals, which',
  '  // increased 502/503 pressure. Leave the helper available, but default it',
  '  // off unless VITE_TIMEFRAME_PREFETCH=1 is explicitly set. UI/data',
  '  // transport only; protected engines untouched.',
  '  useEffect(() => {',
  '    const enabled = import.meta.env.VITE_TIMEFRAME_PREFETCH === "1";',
  '    if (!enabled) return;',
  '    if (!symbol || !interval || !candleResponse?.candles?.length) return;',
  '    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;',
  '',
  '    const controller = new AbortController();',
  '    const delayMs = Math.max(',
  '      1500,',
  '      Number(import.meta.env.VITE_TIMEFRAME_PREFETCH_DELAY_MS ?? "2500") || 2_500,',
  '    );',
  '    const timer = window.setTimeout(() => {',
  '      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;',
  '      for (const nextInterval of adjacentIntervalsForPrefetch(interval)) {',
  '        prefetchStructuralLevels(symbol, nextInterval);',
  '        const limit = fastCandleLimitForInterval(nextInterval);',
  '        const url = apiUrl(',
  '          `/api/liquidity/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(nextInterval)}&limit=${limit}`,',
  '        );',
  '        fetch(url, {',
  '          signal: controller.signal,',
  '          credentials: "include",',
  '          cache: "no-store",',
  '          headers: {',
  '            "x-fetch-priority": "low",',
  '            "x-prefetch-reason": "timeframe-switch",',
  '          },',
  '        }).catch(() => {});',
  '      }',
  '    }, delayMs);',
  '',
  '    return () => {',
  '      window.clearTimeout(timer);',
  '      controller.abort();',
  '    };',
  '  }, [symbol, interval, candleResponse?.candles?.length]);',
].join('\n');

apply(
  '  // Phase 3 / T125 (S5) shadow: every time the legacy useGetCandles hook',
  `${prefetchEffect}\n\n  // Phase 3 / T125 (S5) shadow: every time the legacy useGetCandles hook`,
  'VITE_TIMEFRAME_PREFETCH === "1"',
  'opt-in adjacent timeframe background prefetch',
);

fs.writeFileSync(file, src);
console.log('[timeframe-switch-performance-patch] complete');

// Run these from this already-wired build step so package.json does not need
// another patch-chain edit.
require('./patch-level-overlay-zoom-stability.cjs');
require('./patch-level-visual-spacing.cjs');
require('./patch-market-blue-level-colors.cjs');
require('./patch-render-runtime-pressure.cjs');
require('./patch-levels-request-resilience.cjs');
require('./patch-chart-request-debounce.cjs');
