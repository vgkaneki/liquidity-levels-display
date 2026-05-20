const fs = require('fs');

const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[chart-runtime-regression-fix] already applied ${label}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[chart-runtime-regression-fix] skipped ${label}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[chart-runtime-regression-fix] applied ${label}`);
}

function patchFile(path, marker, label, mutator) {
  let body = fs.readFileSync(path, 'utf8');
  if (body.includes(marker)) {
    console.log(`[chart-runtime-regression-fix] already applied ${label}`);
    return;
  }
  const next = mutator(body);
  if (next === body) {
    console.log(`[chart-runtime-regression-fix] skipped ${label}`);
    return;
  }
  fs.writeFileSync(path, next);
  console.log(`[chart-runtime-regression-fix] applied ${label}`);
}

function replaceOrThrow(body, find, replace, label) {
  if (!body.includes(find)) {
    console.log(`[chart-runtime-regression-fix] skipped ${label}`);
    return body;
  }
  console.log(`[chart-runtime-regression-fix] applied ${label}`);
  return body.replace(find, replace);
}

// chartRuntimeRegressionFixV1:
// Fixes regressions observed after the cleanup pass:
// 1) level lines disappearing during zoom because display compaction mutated
//    the actual line array instead of only reducing labels/badges;
// 2) status-line OHLC/volume changing while zooming because a parked/touch
//    crosshair was reused as the active hover candle;
// 3) candle charts showing "chart data unavailable" when heatmap/orderbook
//    context was missing even though real candles were present.
// Display/runtime only. Protected liquidity/structural formulas, confluence,
// scoring, touch classification, DOM, Bookmap, absorption, and level accuracy
// rules are untouched.

// Keep lines stable during zoom. The previous visual compaction selected a
// subset of lines and assigned it back to `lines`, so the actual horizontal
// lines appeared/disappeared as Y spacing changed. We keep all filtered real
// lines and leave future compaction to labels/badges only.
apply(
`      if (selected.length > 0) {
        lines = selected
          .sort((a, b) => a.line.price - b.line.price)
          .map((item) => item.line);
      }`,
`      if (selected.length > 0) {
        // chartRuntimeRegressionFixV1: do not mutate the actual rendered
        // level-line set based on zoom-dependent pixel spacing. Lines must be
        // stable while zooming; only labels/badges may be compacted later.
        const zoomStableLabelCandidates = selected
          .sort((a, b) => a.line.price - b.line.price)
          .map((item) => item.line);
        void zoomStableLabelCandidates;
      }`,
'chartRuntimeRegressionFixV1: do not mutate the actual rendered',
'keep level lines zoom-stable',
);

// Status-line OHLCV should track the latest candle unless the user is actively
// hovering with the mouse. A parked/touch crosshair is a readout aid and should
// not make wheel/pinch zoom change the top current OHLC/volume values.
apply(
`      const hp = hoverRef.current ?? parkedRef.current;
      if (hp && hp.x > 0 && hp.x < chartW && hp.y > 0 && hp.y < chartH) {`,
`      // chartRuntimeRegressionFixV1: use only live mouse hover for status-line
      // candle selection. Parked touch crosshair remains visible below, but it
      // no longer makes zooming change the top current OHLC/volume display.
      const hp = hoverRef.current;
      if (hp && hp.x > 0 && hp.x < chartW && hp.y > 0 && hp.y < chartH) {`,
'Parked touch crosshair remains visible below',
'prevent parked crosshair from changing OHLC on zoom',
);

// Let candles render even if heatmap/orderbook context is temporarily missing.
// This addresses symbols where candle data exists but the upstream heatmap
// payload is unavailable/cold. We build a minimal display-only data context
// from the latest real candle and then route renderChart's data reads through
// `renderData`.
apply(
`    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // When upstream heatmap data is unavailable (loading or error), clear`,
`    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // chartRuntimeRegressionFixV1: candle-first fallback. If heatmap/orderbook
    // context is missing but real candles are present, keep rendering the chart
    // using a minimal display-only context seeded from the latest candle. This
    // does not fabricate engine levels or feed any protected formula path.
    const fallbackCandlesForRender = displayApiCandles ?? apiCandles;
    const fallbackLastCandle = fallbackCandlesForRender?.[fallbackCandlesForRender.length - 1];
    const renderData = data ?? (fallbackLastCandle
      ? ({
          symbol: normalizeSymbolKey(symbol),
          markPrice: fallbackLastCandle.close,
          bids: [],
          asks: [],
          updatedAt: new Date(fallbackLastCandle.timestamp).toISOString(),
        } as any)
      : null);

    // When upstream heatmap data is unavailable (loading or error), clear`,
'const renderData = data ??',
'add candle-first render data fallback',
);

apply(
`    if (!data) {`,
`    if (!renderData) {`,
'if (!renderData)',
'use renderData for no-data state',
);

// Replace renderChart data reads with renderData. Limit the replacement to the
// renderChart callback so unrelated component state/dependency code is not
// touched. This keeps the fallback local to drawing/rendering only.
if (!src.includes('renderDataScopedReplacementV1')) {
  const start = src.indexOf('  const renderChart = useCallback(() => {');
  const end = src.indexOf('\n  }, [', start);
  if (start >= 0 && end > start) {
    let block = src.slice(start, end);
    block = block
      .replace(/\bdata\?\./g, 'renderData?.')
      .replace(/\bdata\./g, 'renderData.');
    block = block.replace(
      'const renderData = data ??',
      'const renderData = data ??',
    );
    block += '\n    // renderDataScopedReplacementV1';
    src = src.slice(0, start) + block + src.slice(end);
    console.log('[chart-runtime-regression-fix] applied renderData scoped replacement');
  } else {
    console.log('[chart-runtime-regression-fix] skipped renderData scoped replacement');
  }
} else {
  console.log('[chart-runtime-regression-fix] already applied renderData scoped replacement');
}

fs.writeFileSync(file, src);

// chartRuntimeHardeningV2:
// Extra runtime hardening requested from the repository audit. These are
// transport/display/storage fixes only. No protected liquidity/structural
// formulas, confluence/scoring, touch classification, DOM/Bookmap, absorption,
// or level-accuracy rules are modified.

// A) Fix 15m line visibility. Registry-backed levels were merged after the
// price-window auto-fit pass, so narrow 15m candle ranges could filter every
// line out even when registry levels were loaded. Include registry levels in
// the display-only fit pass before the visible-line filter runs.
patchFile(
  'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx',
  'registryLevelFit15mV1',
  '15m registry-backed level fit',
  (body) => replaceOrThrow(
    body,
`    const symbolKey = normalizeSymbolKey(chartSymbol);
    const existingLevels = levelRegistries[symbolKey];
    if (existingLevels && renderData.markPrice > 0) {
      const fitLo = candleLow - range0 * OVERLAY_FIT_RANGE_MULTIPLIER;
      const fitHi = candleHigh + range0 * OVERLAY_FIT_RANGE_MULTIPLIER;
      const fitPad = Math.max(
        range0 * OVERLAY_FIT_PAD_MULTIPLIER,
        renderData.markPrice * 0.0006,
      );
      const maxExtension = range0 * OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER;
      let nearestBelow: number | null = null;
      let nearestAbove: number | null = null;
      for (const lvl of existingLevels) {
        if (lvl.tier !== "elite" && lvl.tier !== "strong") continue;
        if (lvl.price < fitLo || lvl.price > fitHi) continue;
        if (lvl.price < candleLow) {
          if (nearestBelow == null || lvl.price > nearestBelow) nearestBelow = lvl.price;
        } else if (lvl.price > candleHigh) {
          if (nearestAbove == null || lvl.price < nearestAbove) nearestAbove = lvl.price;
        }
      }
      if (nearestBelow != null) {
        const belowTarget = nearestBelow - fitPad;
        minPrice = Math.max(belowTarget, minPrice - maxExtension);
      }
      if (nearestAbove != null) {
        const aboveTarget = nearestAbove + fitPad;
        maxPrice = Math.min(aboveTarget, maxPrice + maxExtension);
      }
    }
`,
`    // registryLevelFit15mV1
    // Include registry-backed levels in the auto-fit pass BEFORE the visible
    // line filter runs. On narrow 15m views, registry levels used to be merged
    // later in the frame, after minPrice/maxPrice were fixed, so they could be
    // immediately filtered out as off-screen. This is display-only fitting; it
    // does not alter any level formulas, scores, confluence, or touch rules.
    const symbolKey = normalizeSymbolKey(chartSymbol);
    const existingLevels = levelRegistries[symbolKey] ?? [];
    const registryFitLevels: Array<{ price: number; tier: "elite" | "strong" | "normal" }> =
      (registryLevelsRef.current ?? []).map((l) => ({
        price: l.price,
        tier: l.tier >= 3 ? "elite" : l.tier === 2 ? "strong" : "normal",
      }));
    const fitLevels: Array<{ price: number; tier: "elite" | "strong" | "normal" }> = [
      ...existingLevels.map((l) => ({ price: l.price, tier: l.tier })),
      ...registryFitLevels,
    ];
    if (fitLevels.length > 0 && renderData.markPrice > 0) {
      const hasRegistryLevels = registryFitLevels.length > 0;
      const fitRangeMultiplier = hasRegistryLevels
        ? Math.max(OVERLAY_FIT_RANGE_MULTIPLIER, 0.65)
        : OVERLAY_FIT_RANGE_MULTIPLIER;
      const fitMaxExtensionMultiplier = hasRegistryLevels
        ? Math.max(OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER, 0.45)
        : OVERLAY_FIT_MAX_EXTENSION_MULTIPLIER;
      const fitLo = candleLow - range0 * fitRangeMultiplier;
      const fitHi = candleHigh + range0 * fitRangeMultiplier;
      const fitPad = Math.max(
        range0 * OVERLAY_FIT_PAD_MULTIPLIER,
        renderData.markPrice * 0.0006,
      );
      const maxExtension = range0 * fitMaxExtensionMultiplier;
      let nearestBelow: number | null = null;
      let nearestAbove: number | null = null;
      for (const lvl of fitLevels) {
        if (lvl.tier !== "elite" && lvl.tier !== "strong") continue;
        if (lvl.price < fitLo || lvl.price > fitHi) continue;
        if (lvl.price < candleLow) {
          if (nearestBelow == null || lvl.price > nearestBelow) nearestBelow = lvl.price;
        } else if (lvl.price > candleHigh) {
          if (nearestAbove == null || lvl.price < nearestAbove) nearestAbove = lvl.price;
        }
      }
      if (nearestBelow != null) {
        const belowTarget = nearestBelow - fitPad;
        minPrice = Math.max(belowTarget, minPrice - maxExtension);
      }
      if (nearestAbove != null) {
        const aboveTarget = nearestAbove + fitPad;
        maxPrice = Math.min(aboveTarget, maxPrice + maxExtension);
      }
    }
`,
    '15m registry-backed level fit',
  ),
);

function patchLiquidationStore({ path, label, typeName, getOneName, getAcrossName, backoffFind, backoffReplace, extraQueuePatch }) {
  patchFile(path, 'liqStoreBoundedAcrossV1', `${label} bounded event store`, (body) => {
    let out = body;
    out = replaceOrThrow(
      out,
      'const MAX_PER_SYMBOL = 500;\n',
      'const MAX_PER_SYMBOL = 500;\nconst ABSOLUTE_MAX_SYMBOLS = Math.max(128, Number(process.env.LIQ_EVENTS_MAX_SYMBOLS ?? "1200") || 1200);\nconst ACROSS_SYMBOL_LIMIT = Math.max(25, Number(process.env.LIQ_EVENTS_ACROSS_SYMBOL_LIMIT ?? "120") || 120);\nconst ACROSS_RESULT_LIMIT = Math.max(10, Number(process.env.LIQ_EVENTS_ACROSS_RESULT_LIMIT ?? "250") || 250);\n',
      `${label} constants`,
    );
    out = replaceOrThrow(
      out,
      `const events = new Map<string, ${typeName}[]>();\n`,
      `const events = new Map<string, ${typeName}[]>();\n\n// liqStoreBoundedAcrossV1: bound symbol keys and avoid full gather+sort for\n// across-symbol snapshots. Display/storage only; does not affect engines.\nfunction pruneEventArray(symbol: string, arr: ${typeName}[], cutoff = Date.now() - RETAIN_MS): void {\n  let drop = 0;\n  while (drop < arr.length && arr[drop]!.ts < cutoff) drop++;\n  if (drop > 0) arr.splice(0, drop);\n  if (arr.length > MAX_PER_SYMBOL) arr.splice(0, arr.length - MAX_PER_SYMBOL);\n  if (arr.length === 0) events.delete(symbol);\n}\n\nfunction evictOldestSymbolKeys(): void {\n  if (events.size <= ABSOLUTE_MAX_SYMBOLS) return;\n  const ranked = Array.from(events.entries())\n    .map(([symbol, arr]) => ({ symbol, newest: arr.length ? arr[arr.length - 1]!.ts : 0 }))\n    .sort((a, b) => a.newest - b.newest);\n  for (const item of ranked) {\n    if (events.size <= ABSOLUTE_MAX_SYMBOLS) break;\n    events.delete(item.symbol);\n  }\n}\n\nfunction pushNewestBounded(out: ${typeName}[], ev: ${typeName}, limit: number): void {\n  if (limit <= 0) return;\n  if (out.length < limit) {\n    out.push(ev);\n    if (out.length === limit) out.sort((a, b) => a.ts - b.ts);\n    return;\n  }\n  if (ev.ts <= out[0]!.ts) return;\n  out[0] = ev;\n  out.sort((a, b) => a.ts - b.ts);\n}\n`,
      `${label} helpers`,
    );
    out = replaceOrThrow(
      out,
      `  const cutoff = Date.now() - RETAIN_MS;\n  let drop = 0;\n  while (drop < arr.length && arr[drop]!.ts < cutoff) drop++;\n  if (drop > 0) arr.splice(0, drop);\n  if (arr.length > MAX_PER_SYMBOL) arr.splice(0, arr.length - MAX_PER_SYMBOL);`,
      `  pruneEventArray(ev.symbol, arr);\n  evictOldestSymbolKeys();`,
      `${label} push prune`,
    );
    out = replaceOrThrow(
      out,
      `  const cutoff = Date.now() - RETAIN_MS;\n  const fresh = arr.filter((e) => e.ts >= cutoff);\n  if (fresh.length !== arr.length) events.set(symbol, fresh);\n  return fresh.slice(-limit).reverse();`,
      `  pruneEventArray(symbol, arr);\n  const fresh = events.get(symbol);\n  if (!fresh || fresh.length === 0) return [];\n  return fresh.slice(-limit).reverse();`,
      `${label} get one prune`,
    );
    out = replaceOrThrow(
      out,
      `export function ${getAcrossName}(\n  symbols: string[],\n  limit: number,\n): ${typeName}[] {\n  const cutoff = Date.now() - RETAIN_MS;\n  const merged: ${typeName}[] = [];\n  for (const s of symbols) {\n    const arr = events.get(s);\n    if (!arr) continue;\n    for (const e of arr) {\n      if (e.ts >= cutoff) merged.push(e);\n    }\n  }\n  merged.sort((a, b) => b.ts - a.ts);\n  return merged.slice(0, limit);\n}\n`,
      `export function ${getAcrossName}(\n  symbols: string[],\n  limit: number,\n): ${typeName}[] {\n  const cappedLimit = Math.max(0, Math.min(ACROSS_RESULT_LIMIT, Math.floor(limit)));\n  if (cappedLimit <= 0) return [];\n  const cutoff = Date.now() - RETAIN_MS;\n  const merged: ${typeName}[] = [];\n  for (const s of symbols.slice(0, ACROSS_SYMBOL_LIMIT)) {\n    const arr = events.get(s);\n    if (!arr) continue;\n    pruneEventArray(s, arr, cutoff);\n    const fresh = events.get(s);\n    if (!fresh) continue;\n    for (const e of fresh) {\n      if (e.ts >= cutoff) pushNewestBounded(merged, e, cappedLimit);\n    }\n  }\n  return merged.sort((a, b) => b.ts - a.ts);\n}\n`,
      `${label} bounded across`,
    );
    out = replaceOrThrow(out, backoffFind, backoffReplace, `${label} jittered backoff`);
    if (extraQueuePatch) out = extraQueuePatch(out);
    return out;
  });
}

patchLiquidationStore({
  path: 'artifacts/api-server/src/routes/liquidity/exchanges/binance-liq-ws.ts',
  label: 'binance-liq',
  typeName: 'BinanceLiquidationEvent',
  getOneName: 'getBinanceLiquidations',
  getAcrossName: 'getRecentBinanceLiquidationsAcross',
  backoffFind: `function backoffMs(): number {\n  return Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n}\n`,
  backoffReplace: `function backoffMs(): number {\n  const base = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n  const jitter = Math.floor(Math.random() * Math.min(2_500, Math.max(250, base * 0.1)));\n  return base + jitter;\n}\n`,
});

patchLiquidationStore({
  path: 'artifacts/api-server/src/routes/liquidity/exchanges/okx-liq-ws.ts',
  label: 'okx-liq',
  typeName: 'LiquidationEvent',
  getOneName: 'getLiquidations',
  getAcrossName: 'getRecentLiquidationsAcross',
  backoffFind: `function backoffMs(): number {\n  return Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n}\n`,
  backoffReplace: `function backoffMs(): number {\n  const base = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n  const jitter = Math.floor(Math.random() * Math.min(2_500, Math.max(250, base * 0.1)));\n  return base + jitter;\n}\n`,
});

patchLiquidationStore({
  path: 'artifacts/api-server/src/routes/liquidity/exchanges/hl-liq-ws.ts',
  label: 'hl-liq',
  typeName: 'HlLiquidationEvent',
  getOneName: 'getHlLiquidations',
  getAcrossName: 'getRecentHlLiquidationsAcross',
  backoffFind: `function backoffMs(): number {\n  if (inStormCooldown) return STORM_COOLDOWN_MS;\n  return Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n}\n`,
  backoffReplace: `function backoffMs(): number {\n  const base = inStormCooldown ? STORM_COOLDOWN_MS : Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n  const jitter = Math.floor(Math.random() * Math.min(5_000, Math.max(250, base * 0.1)));\n  return base + jitter;\n}\n`,
  extraQueuePatch: (out) => {
    out = replaceOrThrow(
      out,
      `const SUB_DRIP_MS = 150;\nconst subQueue: (() => void)[] = [];\nlet pumping = false;`,
      `const SUB_DRIP_MS = 150;\nconst SUB_QUEUE_MAX = Math.max(50, Number(process.env.HL_LIQ_SUB_QUEUE_MAX ?? "250") || 250);\nconst subQueue: (() => void)[] = [];\nconst queuedSubOps = new Set<string>();\nlet pumping = false;`,
      'hl queue constants',
    );
    out = replaceOrThrow(
      out,
      `function subscribeCoin(coin: string): void {\n  subQueue.push(() => send({ method: "subscribe", subscription: { type: "trades", coin } }));\n  pumpSubQueue();\n}\nfunction unsubscribeCoin(coin: string): void {\n  subQueue.push(() => send({ method: "unsubscribe", subscription: { type: "trades", coin } }));\n  pumpSubQueue();\n}\n`,
      `function queueSubOp(key: string, op: () => void): void {\n  if (queuedSubOps.has(key)) return;\n  if (subQueue.length >= SUB_QUEUE_MAX) {\n    logger.warn({ exchange: "hl-liq", queued: subQueue.length, max: SUB_QUEUE_MAX }, "hl-liq-ws: subscription queue full");\n    return;\n  }\n  queuedSubOps.add(key);\n  subQueue.push(() => {\n    queuedSubOps.delete(key);\n    op();\n  });\n  pumpSubQueue();\n}\nfunction subscribeCoin(coin: string): void {\n  queueSubOp(` + '`sub:${coin}`' + `, () => send({ method: "subscribe", subscription: { type: "trades", coin } }));\n}\nfunction unsubscribeCoin(coin: string): void {\n  queueSubOp(` + '`unsub:${coin}`' + `, () => send({ method: "unsubscribe", subscription: { type: "trades", coin } }));\n}\n`,
      'hl queue dedupe',
    );
    return out;
  },
});

patchLiquidationStore({
  path: 'artifacts/api-server/src/routes/liquidity/exchanges/bybit-liq-ws.ts',
  label: 'bybit-liq',
  typeName: 'BybitLiquidationEvent',
  getOneName: 'getBybitLiquidations',
  getAcrossName: 'getRecentBybitLiquidationsAcross',
  backoffFind: `function backoffMs(): number {\n  return Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n}\n`,
  backoffReplace: `function backoffMs(): number {\n  const base = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));\n  const jitter = Math.floor(Math.random() * Math.min(2_500, Math.max(250, base * 0.1)));\n  return base + jitter;\n}\n`,
  extraQueuePatch: (out) => {
    out = replaceOrThrow(
      out,
      `const subQueue: (() => void)[] = [];\nlet pumping = false;`,
      `const SUB_QUEUE_MAX = Math.max(50, Number(process.env.BYBIT_LIQ_SUB_QUEUE_MAX ?? "300") || 300);\nconst subQueue: (() => void)[] = [];\nconst queuedSubOps = new Set<string>();\nlet pumping = false;`,
      'bybit queue constants',
    );
    out = replaceOrThrow(
      out,
      `function subscribeSymbols(syms: string[]): void {\n  if (syms.length === 0) return;\n  // One arg per frame: Bybit rejects the entire frame if a single symbol\n  // isn't listed on the linear venue (TRUMPUSDT, POLUSDT, etc.). The\n  // throttled queue absorbs the extra frames cheaply.\n  for (const sym of syms) {\n    subQueue.push(() =>\n      send({ op: "subscribe", args: [\`allLiquidation.\${sym}\`] }),\n    );\n  }\n  pumpSubQueue();\n}\n\nfunction unsubscribeSymbols(syms: string[]): void {\n  if (syms.length === 0) return;\n  for (const sym of syms) {\n    subQueue.push(() =>\n      send({ op: "unsubscribe", args: [\`allLiquidation.\${sym}\`] }),\n    );\n  }\n  pumpSubQueue();\n}\n`,
      `function queueSubOp(key: string, op: () => void): void {\n  if (queuedSubOps.has(key)) return;\n  if (subQueue.length >= SUB_QUEUE_MAX) {\n    logger.warn({ exchange: "bybit-liq", queued: subQueue.length, max: SUB_QUEUE_MAX }, "bybit-liq-ws: subscription queue full");\n    return;\n  }\n  queuedSubOps.add(key);\n  subQueue.push(() => {\n    queuedSubOps.delete(key);\n    op();\n  });\n  pumpSubQueue();\n}\n\nfunction subscribeSymbols(syms: string[]): void {\n  if (syms.length === 0) return;\n  // One arg per frame: Bybit rejects the entire frame if a single symbol\n  // isn't listed on the linear venue (TRUMPUSDT, POLUSDT, etc.). The\n  // throttled queue absorbs the extra frames cheaply.\n  for (const sym of syms) {\n    queueSubOp(` + '`sub:${sym}`' + `, () => send({ op: "subscribe", args: [` + '`allLiquidation.${sym}`' + `] }));\n  }\n}\n\nfunction unsubscribeSymbols(syms: string[]): void {\n  if (syms.length === 0) return;\n  for (const sym of syms) {\n    queueSubOp(` + '`unsub:${sym}`' + `, () => send({ op: "unsubscribe", args: [` + '`allLiquidation.${sym}`' + `] }));\n  }\n}\n`,
      'bybit queue dedupe',
    );
    return out;
  },
});

// B) Browser datafeed websocket: avoid resubscribe bursts on reconnect and add
// reconnect jitter. This only throttles client->server subscription frames.
patchFile(
  'artifacts/liquidity-heatmap/src/datafeed/wsClient.ts',
  'datafeedWsDripReconnectV1',
  'datafeed WS drip reconnect',
  (body) => {
    let out = body;
    out = replaceOrThrow(
      out,
      `  private pingTimer: ReturnType<typeof setInterval> | null = null;\n  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;\n`,
      `  private pingTimer: ReturnType<typeof setInterval> | null = null;\n  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;\n  private outboundQueue: object[] = [];\n  private outboundTimer: ReturnType<typeof setTimeout> | null = null;\n`,
      'datafeed ws queue fields',
    );
    out = replaceOrThrow(
      out,
      `      // Re-sub everything we still want.\n      for (const channel of this.channels.keys()) {\n        this.send({ op: "sub", channel });\n      }\n`,
      `      // datafeedWsDripReconnectV1: re-subscribe through the outbound drip\n      // queue so reconnects do not burst dozens of frames at the server.\n      for (const channel of this.channels.keys()) {\n        this.enqueueSend({ op: "sub", channel });\n      }\n`,
      'datafeed ws open replay',
    );
    out = replaceOrThrow(
      out,
      `      if (this.pingTimer) {\n        clearInterval(this.pingTimer);\n        this.pingTimer = null;\n      }\n      this.ws = null;\n`,
      `      if (this.pingTimer) {\n        clearInterval(this.pingTimer);\n        this.pingTimer = null;\n      }\n      if (this.outboundTimer) {\n        clearTimeout(this.outboundTimer);\n        this.outboundTimer = null;\n      }\n      this.outboundQueue = [];\n      this.ws = null;\n`,
      'datafeed ws close queue cleanup',
    );
    out = replaceOrThrow(
      out,
      `    const ms = this.reconnectMs;\n    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);\n`,
      `    const jitter = Math.floor(Math.random() * Math.min(1_000, Math.max(100, this.reconnectMs * 0.2)));\n    const ms = this.reconnectMs + jitter;\n    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);\n`,
      'datafeed ws reconnect jitter',
    );
    out = replaceOrThrow(
      out,
      `  private send(op: object): void {\n    if (this.ws?.readyState !== WebSocket.OPEN) return;\n    try {\n      this.ws.send(JSON.stringify(op));\n    } catch {\n      // swallow\n    }\n  }\n`,
      `  private enqueueSend(op: object): void {\n    if (this.outboundQueue.length > 500) this.outboundQueue.shift();\n    this.outboundQueue.push(op);\n    this.pumpOutboundQueue();\n  }\n\n  private pumpOutboundQueue(): void {\n    if (this.outboundTimer) return;\n    const tick = () => {\n      this.outboundTimer = null;\n      if (this.ws?.readyState !== WebSocket.OPEN) return;\n      const batch = this.outboundQueue.splice(0, 8);\n      for (const op of batch) this.send(op);\n      if (this.outboundQueue.length > 0) {\n        this.outboundTimer = setTimeout(tick, 25);\n      }\n    };\n    this.outboundTimer = setTimeout(tick, 0);\n  }\n\n  private send(op: object): void {\n    if (this.ws?.readyState !== WebSocket.OPEN) return;\n    try {\n      this.ws.send(JSON.stringify(op));\n    } catch {\n      // swallow\n    }\n  }\n`,
      'datafeed ws queue methods',
    );
    out = replaceOrThrow(
      out,
      `        this.send({ op: "sub", channel });\n`,
      `        this.enqueueSend({ op: "sub", channel });\n`,
      'datafeed ws subscribe queue',
    );
    out = replaceOrThrow(
      out,
      `        this.send({ op: "unsub", channel });\n`,
      `        this.enqueueSend({ op: "unsub", channel });\n`,
      'datafeed ws unsubscribe queue',
    );
    return out;
  },
);

console.log('[chart-runtime-regression-fix] complete');
