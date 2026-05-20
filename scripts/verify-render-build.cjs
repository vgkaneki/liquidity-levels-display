const fs = require('fs');
const { execFileSync } = require('child_process');

const phase = process.env.RENDER_VERIFY_PHASE || 'pre';
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  const tag = ok ? 'OK' : 'FAIL';
  console.log(`[render-verify:${phase}] ${tag}: ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function exists(file, name) {
  check(name, fs.existsSync(file), file);
}

function contains(file, marker, name) {
  const text = read(file);
  check(name, text.includes(marker), `${file} :: ${marker}`);
}

function notContains(file, marker, name) {
  const text = read(file);
  check(name, !text.includes(marker), `${file} :: ${marker}`);
}

try {
  execFileSync(process.execPath, ['scripts/guard-protected-engines.cjs'], { stdio: 'pipe' });
  check('protected original engines unchanged', true, 'guard-protected-engines passed');
} catch (err) {
  check('protected original engines unchanged', false, String(err && err.message ? err.message : err));
}

const pkg = JSON.parse(read('package.json') || '{}');
const renderScript = pkg.scripts && pkg.scripts['build:render'] ? String(pkg.scripts['build:render']) : '';
const patchRunner = read('scripts/apply-render-patches.cjs');
const preBuildVerifierIndex = renderScript.indexOf('node scripts/verify-render-build.cjs');
const firstBuildIndex = renderScript.indexOf('pnpm --filter @workspace/liquidity-heatmap build');
check('build:render script exists', renderScript.length > 0, 'package.json scripts.build:render');
check('build:render uses centralized patch runner', renderScript.includes('apply-render-patches.cjs'), 'package.json scripts.build:render');
check('build:render verifies before build', preBuildVerifierIndex >= 0 && firstBuildIndex > preBuildVerifierIndex, 'pre-build verification');
check('build:render verifies after build', renderScript.includes('RENDER_VERIFY_PHASE=post node scripts/verify-render-build.cjs'), 'post-build verification');

for (const required of [
  'patch-startup-performance.cjs',
  'patch-background-workload.cjs',
  'patch-loading-performance.cjs',
  'patch-fast-page-load.cjs',
  'patch-runtime-performance.cjs',
  'patch-restore-engine-lookback-integrity.cjs',
  'patch-timeframe-switch-performance.cjs',
  'patch-chart-stability-modules.cjs',
  'patch-latency-cleanup-v2.cjs',
  'patch-frontend-timeframe-debounce.cjs',
  'patch-live-rest-warm-opt-in.cjs',
  'patch-security-ops-hardening-v1.cjs',
]) {
  check(`central patch runner includes ${required}`, patchRunner.includes(required), required);
}
for (const forbidden of [
  'patch-level-engine-bugfixes.cjs',
  'patch-level-engine-bugfixes-v2.cjs',
  'patch-anchor-level-timeframes.cjs',
]) {
  check(`build:render excludes ${forbidden}`, !renderScript.includes(forbidden), forbidden);
  check(`central patch runner excludes ${forbidden}`, !patchRunner.includes(forbidden), forbidden);
}

// Source/helper existence checks.
exists('artifacts/liquidity-heatmap/src/lib/chartReadiness.ts', 'chart readiness helper exists');
exists('artifacts/liquidity-heatmap/src/lib/chartNetworkDiagnostics.ts', 'chart websocket diagnostics helper exists');
exists('artifacts/liquidity-heatmap/src/lib/chartCandleFallback.ts', 'chart candle fallback helper exists');
exists('artifacts/liquidity-heatmap/src/lib/chartFormatters.ts', 'chart formatter module exists');
exists('artifacts/liquidity-heatmap/src/lib/chartIndicators.ts', 'chart indicator module exists');
exists('artifacts/liquidity-heatmap/src/lib/chartTransforms.ts', 'chart transform module exists');
exists('artifacts/liquidity-heatmap/src/lib/chartLevelRenderer.ts', 'chart level renderer module exists');
exists('artifacts/liquidity-heatmap/src/lib/chartDrawingRenderer.ts', 'chart drawing renderer module exists');
exists('artifacts/liquidity-heatmap/src/lib/chartOverlayRenderer.ts', 'chart overlay renderer module exists');
exists('artifacts/liquidity-heatmap/src/components/system/PerformanceDiagnosticsBadge.tsx', 'performance diagnostics badge exists');
exists('scripts/patch-chart-stability-modules.cjs', 'chart stability modules patch exists');
exists('scripts/patch-levels-request-resilience.cjs', 'levels request resilience patch exists');
exists('scripts/patch-chart-request-debounce.cjs', 'chart request debounce patch exists');
exists('scripts/patch-latency-cleanup-v2.cjs', 'latency cleanup v2 patch exists');
exists('scripts/patch-frontend-timeframe-debounce.cjs', 'frontend timeframe debounce patch exists');
exists('scripts/patch-live-rest-warm-opt-in.cjs', 'live REST boot warm opt-in patch exists');
exists('scripts/patch-security-ops-hardening-v1.cjs', 'security ops hardening patch exists');
exists('docs/production-runtime.md', 'production runtime documentation exists');
exists('docs/code-review-checklist-status-v1.md', 'code review checklist status map exists');

// Server startup/runtime pressure checks.
contains('artifacts/api-server/src/index.ts', 'startupPerformanceV2', 'startup warmups opt-in marker present');
contains('artifacts/api-server/src/index.ts', 'ENABLE_CRITICAL_BOOT_WARM', 'critical startup warm opt-in control present');
contains('artifacts/api-server/src/index.ts', 'BOOT_WARM_PAIRS', 'explicit startup warm pair control present');
contains('artifacts/api-server/src/index.ts', 'backgroundWorkloadV2', 'background workload throttling marker present');
contains('artifacts/api-server/src/index.ts', 'BACKGROUND_START_DELAY_MS', 'background delay control present');
contains('artifacts/api-server/src/index.ts', 'ENABLE_MARKET_OVERVIEW_WARM', 'market overview opt-in control present');
contains('artifacts/api-server/src/routes/liquidity/index.ts', 'foregroundApiMicrocacheV1', 'foreground REST microcache marker present');
contains('artifacts/api-server/src/routes/liquidity/index.ts', 'foregroundCandlePressureV1', 'foreground candle pressure cap present');
contains('artifacts/api-server/src/routes/liquidity/exchanges/live.ts', 'liveRestWarmOptInV1', 'live REST boot warm opt-in marker present');
contains('artifacts/api-server/src/app.ts', 'fastStaticShellV1', 'early static shell marker present');
contains('artifacts/api-server/src/app.ts', 'loadingPerformanceV1', 'request logging skip marker present');
contains('artifacts/api-server/src/app.ts', 'assetCacheV1', 'static asset cache marker present');
contains('artifacts/api-server/src/services/symbolRegistry/index.ts', 'renderRuntimePressureV1', 'render runtime pressure marker present');

// Security/operations hardening checks.
contains('artifacts/api-server/src/app.ts', 'securityOpsHardeningV1', 'api security hardening marker present');
contains('artifacts/api-server/src/app.ts', 'X-Request-Id', 'request id response header present');
contains('artifacts/api-server/src/app.ts', 'csrfOriginGuard', 'csrf origin guard marker present');
contains('artifacts/api-server/src/app.ts', 'API_RATE_LIMIT_MAX', 'api rate limit env control present');
contains('artifacts/api-server/src/app.ts', '/api/readyz', 'readiness endpoint present');
contains('artifacts/api-server/src/index.ts', 'serverLifecycleHardeningV1', 'server lifecycle hardening marker present');
contains('artifacts/api-server/src/index.ts', 'SERVER_REQUEST_TIMEOUT_MS', 'server request timeout env control present');
contains('artifacts/api-server/src/index.ts', 'process.once("SIGTERM"', 'SIGTERM graceful shutdown handler present');
contains('artifacts/api-server/src/index.ts', 'unhandledRejection', 'unhandled rejection logging present');

// Backend route-boundary validation checks.
contains('artifacts/api-server/src/routes/watchlists.ts', 'watchlistInputHardeningV1', 'watchlist input hardening marker present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'MAX_WATCHLIST_NAME_LEN', 'watchlist name length cap present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'MAX_REORDER_SYMBOLS', 'watchlist reorder array cap present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'SYMBOL_RE', 'watchlist symbol format validation present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'readSymbol(req.body?.symbol)', 'watchlist add-symbol validation wired');
contains('artifacts/api-server/src/routes/watchlists.ts', 'readSymbol(req.params.symbol)', 'watchlist delete-symbol validation wired');

// Backend workload cleanup checks.
contains('artifacts/api-server/src/services/marketOverview.ts', 'MARKET_OVERVIEW_MAX_INSTRUMENTS', 'market overview instrument cap present');
contains('artifacts/api-server/src/services/marketOverview.ts', 'MARKET_OVERVIEW_WARM_ENABLED', 'market overview warm opt-in present');
contains('artifacts/api-server/src/services/wsHub/index.ts', 'MARKET_OVERVIEW_REBUILD_MIN_MS', 'market overview rebuild throttle present');
contains('artifacts/api-server/src/services/wsHub/index.ts', 'book ticks are too frequent', 'book-driven market overview rebuild disabled');
contains('artifacts/api-server/src/services/alertEngine/index.ts', 'ALERT_RULE_RELOAD_MS', 'alert reload cadence control present');
contains('artifacts/api-server/src/services/alertEngine/index.ts', 'ALERT_DISPATCH_CONCURRENCY', 'alert dispatch queue control present');
contains('artifacts/api-server/src/services/alertEngine/index.ts', 'pendingLevelEval', 'level alert debounce present');
contains('artifacts/api-server/src/routes/liquidity/analytics-store.ts', 'ANALYTICS_DEMAND_TTL_MS', 'analytics demand gating present');
contains('artifacts/api-server/src/routes/liquidity/analytics-store.ts', 'markAnalyticsDemand(symbol)', 'analytics endpoint marks demand');

// Chart request, overlay, and websocket cleanup checks.
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'timeframeSwitchPerfV1', 'fast-first candle loading marker present');
contains('artifacts/liquidity-heatmap/src/pages/Heatmap.tsx', 'timeframeSwitchDebounceV1', 'frontend timeframe debounce marker present');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'latencyCleanupV2', 'latency cleanup v2 marker present');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'displayApiCandles', 'last-good display candle fallback wired');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'retry: 1', 'candle retry reduced');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'candleWatchdogDelayMs()', 'mobile-aware watchdog wired');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'networkQuietV1', 'chart liquidation polling throttle marker present');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'chartStabilityModulesV1', 'chart stability split marker present');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'isChartReadyForOverlays', 'chart-ready overlay gate wired');
contains('artifacts/liquidity-heatmap/src/lib/chartReadiness.ts', 'chartReadyForOverlaysV1', 'chart readiness helper marker present');
contains('artifacts/liquidity-heatmap/src/lib/chartNetworkDiagnostics.ts', 'chartWsDiagnosticsV1', 'websocket diagnostics helper marker present');
contains('artifacts/liquidity-heatmap/src/components/system/PerformanceDiagnosticsBadge.tsx', 'performanceDiagnosticsBadgeV1', 'visible performance diagnostics badge marker present');
contains('artifacts/liquidity-heatmap/src/App.tsx', 'PerformanceDiagnosticsBadge', 'performance diagnostics badge mounted');
contains('artifacts/liquidity-heatmap/src/hooks/useChannel.ts', 'wsRafCoalesceV1', 'visual websocket coalescing marker present');
contains('artifacts/liquidity-heatmap/src/hooks/useChannel.ts', 'recordWsDiagnostic', 'websocket diagnostics wired into shared client');
contains('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', 'levelsRequestResilienceV1', 'foreground structural level priority marker present');
contains('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', 'chartRequestDebounceV1', 'structural fetch debounce marker present');
contains('artifacts/api-server/src/routes/levels.ts', 'levelsRequestResilienceV1', 'levels route pending-skeleton marker present');
contains('artifacts/liquidity-heatmap/src/hooks/useAnalyticsOverlays.ts', 'chartRequestDebounceV1', 'analytics overlay debounce marker present');
contains('artifacts/liquidity-heatmap/src/hooks/useLiquidationClusters.ts', 'chartRequestDebounceV1', 'liquidation cluster debounce marker present');
contains('artifacts/liquidity-heatmap/src/hooks/useUpstreamPressure.ts', 'pollMs = 30_000', 'frontend upstream pressure polling slowed');

// Existing UI/performance markers.
contains('artifacts/liquidity-heatmap/src/App.tsx', 'queryDefaultsV1', 'query default marker present');
contains('artifacts/liquidity-heatmap/src/App.tsx', 'lazyChartSettingsDialogV1', 'lazy settings marker present');
contains('artifacts/liquidity-heatmap/src/pages/Heatmap.tsx', 'lazyHeatmapPanelsV1', 'lazy heatmap panels marker present');
contains('artifacts/liquidity-heatmap/vite.config.ts', 'productionViteSlimV1', 'production vite slimming marker present');
contains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'visualLevelSpacingV1', 'visual level spacing marker present');
contains('artifacts/liquidity-heatmap/src/lib/chartSettings.tsx', 'marketBlueLevelColorsV1', 'market blue palette marker present');

// Documentation and generated/bulky artifact cleanup checks.
contains('.gitignore', 'reports/*.json', 'generated JSON reports ignored');
contains('.gitignore', '*full-source*.zip', 'full-source export zips ignored');
contains('.gitignore', '*.cpuprofile', 'performance traces ignored');
contains('.gitignore', '.env', 'local env files ignored');
contains('.gitignore', '*.pem', 'private key artifacts ignored');
contains('.gitignore', '!.env.example', 'example env files allowed');
contains('docs/production-runtime.md', 'SESSION_SECRET', 'production session secret documented');
contains('docs/production-runtime.md', 'DATABASE_URL', 'production database url documented');
contains('docs/production-runtime.md', '/api/readyz', 'readiness health check documented');
contains('docs/code-review-checklist-status-v1.md', 'Protected engine policy', 'checklist protected engine policy documented');
contains('docs/code-review-checklist-status-v1.md', 'External-only items', 'external-only checklist items documented');

// Post-build checks verify bundles exist after the actual frontend/backend build.
if (phase === 'post') {
  const distCandidates = [
    'artifacts/liquidity-heatmap/dist',
    'artifacts/api-server/dist',
  ];
  for (const p of distCandidates) exists(p, `post-build output exists: ${p}`);
}

// Negative safety checks.
notContains('package.json', 'patch-anchor-level-timeframes.cjs', 'anchored timeframe patch not in active build');
notContains('package.json', 'patch-level-engine-bugfixes-v2.cjs', 'engine bugfix patch not in active build');
notContains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'placeholderData: (previousData: any) => previousData', 'unsafe candle placeholderData removed');
notContains('artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx', 'placeholderData: expandedHistory', 'old expandedHistory placeholderData removed');

const failed = checks.filter((c) => !c.ok);
const summary = {
  ok: failed.length === 0,
  phase,
  checkedAt: new Date().toISOString(),
  failedCount: failed.length,
  totalChecks: checks.length,
  checks,
};

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(`reports/render-build-verification-${phase}.json`, JSON.stringify(summary, null, 2));
fs.writeFileSync(
  `reports/render-build-verification-${phase}.md`,
  [
    '# Render Build Verification',
    '',
    `Phase: ${phase}`,
    `Status: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `Checked at: ${summary.checkedAt}`,
    `Checks: ${summary.totalChecks}`,
    `Failures: ${summary.failedCount}`,
    '',
    '## Scope',
    '',
    'Verifies centralized Render patch-chain wiring, protected-engine guard status, chart request-pressure cleanup, overlay readiness gating, WebSocket diagnostics, startup warmup controls, backend workload cleanup, route-boundary validation markers, security/operations hardening markers, operational documentation, generated-artifact ignores, and known unsafe placeholder-data regressions.',
    '',
    '## Results',
    ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    '',
  ].join('\n'),
);

if (!summary.ok) {
  console.error(`[render-verify:${phase}] failed ${failed.length}/${checks.length} checks`);
  process.exit(1);
}

console.log(`[render-verify:${phase}] PASS: ${checks.length} checks passed`);
