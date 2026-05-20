const fs = require('fs');
const indexFile = 'artifacts/api-server/src/index.ts';
const liquidityFile = 'artifacts/api-server/src/routes/liquidity/index.ts';
let src = fs.readFileSync(indexFile, 'utf8');

function apply(find, replace, marker) {
  if (src.includes(marker)) {
    console.log(`[background-workload-patch] already applied ${marker}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[background-workload-patch] skipped ${marker}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[background-workload-patch] applied ${marker}`);
}

function applyRegex(regex, replace, marker) {
  if (src.includes(marker)) {
    console.log(`[background-workload-patch] already applied ${marker}`);
    return;
  }
  if (!regex.test(src)) {
    console.log(`[background-workload-patch] skipped ${marker}`);
    return;
  }
  src = src.replace(regex, replace);
  console.log(`[background-workload-patch] applied ${marker}`);
}

function patchText(file, fn) {
  let text = fs.readFileSync(file, 'utf8');
  const next = fn(text);
  if (next !== text) fs.writeFileSync(file, next);
}

function replaceText(text, find, replace, marker, label) {
  if (text.includes(marker)) {
    console.log(`[background-workload-patch] already applied ${label}`);
    return text;
  }
  if (!text.includes(find)) {
    console.log(`[background-workload-patch] skipped ${label}`);
    return text;
  }
  console.log(`[background-workload-patch] applied ${label}`);
  return text.replace(find, replace);
}

apply(
`const CRITICAL_BOOT_WARM = new Set([
  "BTCUSDT|1m", "BTCUSDT|5m", "BTCUSDT|15m",
  "ETHUSDT|1m", "ETHUSDT|5m", "ETHUSDT|15m",
  "SOLUSDT|1m", "SOLUSDT|5m", "SOLUSDT|15m",
]);`,
`const CRITICAL_BOOT_WARM = new Set([
  "BTCUSDT|1m", "BTCUSDT|5m", "BTCUSDT|15m",
  "ETHUSDT|1m", "ETHUSDT|5m", "ETHUSDT|15m",
  "SOLUSDT|1m", "SOLUSDT|5m", "SOLUSDT|15m",
]);

// backgroundWorkloadV2: defer non-critical warmers until after the app shell
// and active chart have had a chance to load. These are scheduling/caching
// controls only; they do not touch engine formulas, scoring, confluence,
// DOM logic, Bookmap logic, absorption, touch classification, or level
// placement. Default market-overview warming is opt-in because it can compete
// with the selected chart during Render cold starts.
const BACKGROUND_START_DELAY_MS = Math.max(
  0,
  Number(process.env["BACKGROUND_START_DELAY_MS"] ?? "60000") || 60_000,
);
const ENABLE_BOOT_WARM = process.env["ENABLE_BOOT_WARM"] !== "0";
const ENABLE_UNIVERSE_WARM = process.env["ENABLE_UNIVERSE_WARM"] !== "0";
const ENABLE_MARKET_OVERVIEW_WARM = process.env["ENABLE_MARKET_OVERVIEW_WARM"] === "1";`,
'backgroundWorkloadV2'
);

apply(
`const BOOT_WARM_STEP_MS = Math.max(
  1_500,
  Number(process.env["BOOT_WARM_STEP_MS"] ?? "2500") || 2_500,
);`,
`const BOOT_WARM_STEP_MS = Math.max(
  3_000,
  Number(process.env["BOOT_WARM_STEP_MS"] ?? "5000") || 5_000,
);`,
'Number(process.env["BOOT_WARM_STEP_MS"] ?? "5000")'
);

apply(
`  // Warm the union universe cache (OKX + HL + Toobit instrument lists) so
  // the unsupported-symbol fast-path in /api/levels is effective from the
  // first user request rather than after a 30s warmup. Background-only —
  // does not block server startup.
  void warmUniverseCache();
  // Background recompute every 25s so the in-memory snapshot is always
  // fresh enough that REST and WS callers hit cache instantly. Replaces
  // the old "compute-on-expiry" pattern that made the first request after
  // any 30s idle gap pay the full 1.8-9s compute cost.
  startMarketOverviewWarm();`,
`  // Background cache work is delayed so the active chart and app shell are not
  // competing with universe/overview warmers during cold start.
  setTimeout(() => {
    if (ENABLE_UNIVERSE_WARM) {
      void warmUniverseCache();
    } else {
      logger.info("universe warm disabled");
    }
    if (ENABLE_MARKET_OVERVIEW_WARM) {
      startMarketOverviewWarm();
    } else {
      logger.info("market overview warm disabled by default");
    }
  }, BACKGROUND_START_DELAY_MS).unref();`,
'Background cache work is delayed'
);

applyRegex(
/  const bootWarmSource = ENABLE_FULL_BOOT_WARM\n    \? WARM\n    : WARM\.filter\(\(\[sym, tf\]\) => CRITICAL_BOOT_WARM\.has\(`\$\{sym\}\|\$\{tf\}`\)\);/,
  "  const bootWarmSource = !ENABLE_BOOT_WARM\n" +
  "    ? []\n" +
  "    : ENABLE_FULL_BOOT_WARM\n" +
  "      ? WARM\n" +
  "      : WARM.filter(([sym, tf]) => CRITICAL_BOOT_WARM.has(`${sym}|${tf}`));",
'!ENABLE_BOOT_WARM'
);

apply(
`    }, idx * BOOT_WARM_STEP_MS).unref();`,
`    }, BACKGROUND_START_DELAY_MS + idx * BOOT_WARM_STEP_MS).unref();`,
'BACKGROUND_START_DELAY_MS + idx * BOOT_WARM_STEP_MS'
);

fs.writeFileSync(indexFile, src);

const foregroundMicrocacheBlock = [
  'const router: IRouter = Router();',
  '',
  '// foregroundApiMicrocacheV1: tiny in-process REST cache for bursty live visual',
  '// endpoints. The chart/DOM/Bookmap can ask for the same heatmap/orderbook',
  '// snapshot multiple times during mount, panel remounts, or mobile layout',
  '// changes. A 350ms cache coalesces those bursts without making trading data',
  '// stale in practice. This is route transport only: protected engines, formulas,',
  '// confluence, scoring, DOM math, Bookmap math, and level placement are untouched.',
  'type ForegroundRestCacheEntry = {',
  '  status: number;',
  '  payload: unknown;',
  '  expiresAt: number;',
  '  headers?: Record<string, string>;',
  '};',
  'const FOREGROUND_REST_TTL_MS = Math.max(',
  '  100,',
  '  Number(process.env["FOREGROUND_REST_TTL_MS"] ?? "350") || 350,',
  ');',
  'const FOREGROUND_REST_CACHE_MAX = 512;',
  'const foregroundRestCache = new Map<string, ForegroundRestCacheEntry>();',
  '',
  'function foregroundRestKey(req: Request): string {',
  '  const params = new URLSearchParams();',
  '  const entries = Object.entries(req.query).sort(([a], [b]) => a.localeCompare(b));',
  '  for (const [key, value] of entries) {',
  '    if (Array.isArray(value)) {',
  '      for (const item of value) params.append(key, String(item));',
  '    } else if (value != null) {',
  '      params.set(key, String(value));',
  '    }',
  '  }',
  '  return req.path + "?" + params.toString();',
  '}',
  '',
  'function getForegroundRestCache(key: string): ForegroundRestCacheEntry | null {',
  '  const entry = foregroundRestCache.get(key);',
  '  if (!entry) return null;',
  '  if (entry.expiresAt <= Date.now()) {',
  '    foregroundRestCache.delete(key);',
  '    return null;',
  '  }',
  '  return entry;',
  '}',
  '',
  'function setForegroundRestCache(',
  '  key: string,',
  '  status: number,',
  '  payload: unknown,',
  '  headers?: Record<string, string>,',
  '): void {',
  '  while (foregroundRestCache.size >= FOREGROUND_REST_CACHE_MAX) {',
  '    const oldest = foregroundRestCache.keys().next().value;',
  '    if (oldest === undefined) break;',
  '    foregroundRestCache.delete(oldest);',
  '  }',
  '  foregroundRestCache.set(key, {',
  '    status,',
  '    payload,',
  '    headers,',
  '    expiresAt: Date.now() + FOREGROUND_REST_TTL_MS,',
  '  });',
  '}',
  '',
  'function sendForegroundRestCache(res: Response, entry: ForegroundRestCacheEntry): void {',
  '  if (entry.headers) {',
  '    for (const [key, value] of Object.entries(entry.headers)) res.setHeader(key, value);',
  '  }',
  '  res.setHeader("X-Foreground-Rest-Cache", "HIT");',
  '  res.status(entry.status).json(entry.payload);',
  '}',
].join('\n');

patchText(liquidityFile, (text) => {
  text = replaceText(
    text,
    `import { Router, type IRouter } from "express";`,
    `import { Router, type IRouter, type Request, type Response } from "express";`,
    'foregroundApiMicrocacheV1',
    'express Request/Response types for microcache',
  );

  text = replaceText(
    text,
    `const router: IRouter = Router();`,
    foregroundMicrocacheBlock,
    'foregroundApiMicrocacheV1',
    'foreground REST microcache helpers',
  );

  text = replaceText(
    text,
    `  const { symbol, levels = 50 } = parsed.data;
  const clampedLevels = Math.min(500, Math.max(10, Number(levels)));
  const sym = normalizeSymbol(symbol);

  const [realBook, realTicker] = await Promise.all([`,
    `  const { symbol, levels = 50 } = parsed.data;
  const clampedLevels = Math.min(500, Math.max(10, Number(levels)));
  const sym = normalizeSymbol(symbol);
  const foregroundKey = foregroundRestKey(req);
  const foregroundCached = getForegroundRestCache(foregroundKey);
  if (foregroundCached) {
    sendForegroundRestCache(res, foregroundCached);
    return;
  }
  live.touchSymbol(sym);

  const [realBook, realTicker] = await Promise.all([`,
    'const foregroundKey = foregroundRestKey(req);',
    'heatmap foreground microcache lookup',
  );

  text = replaceText(
    text,
    `  res.json({
    symbol: sym,
    exchange,
    priceSource,
    priceType: realTicker.priceType,
    markPrice,
    indexPrice,
    fundingRate: parseFloat(fundingRate.toFixed(6)),
    openInterest,
    volume24h,
    priceChange24h,
    levels: heatLevels,
    updatedAt: new Date().toISOString(),
  });`,
    `  const payload = {
    symbol: sym,
    exchange,
    priceSource,
    priceType: realTicker.priceType,
    markPrice,
    indexPrice,
    fundingRate: parseFloat(fundingRate.toFixed(6)),
    openInterest,
    volume24h,
    priceChange24h,
    levels: heatLevels,
    updatedAt: new Date().toISOString(),
  };
  res.setHeader("X-Foreground-Rest-Cache", "MISS");
  setForegroundRestCache(foregroundKey, 200, payload, { "X-Foreground-Rest-Cache": "HIT" });
  res.json(payload);`,
    'setForegroundRestCache(foregroundKey, 200, payload',
    'heatmap foreground microcache store',
  );

  text = replaceText(
    text,
    `  const { symbol, depth = 100 } = parsed.data;
  const sym = normalizeSymbol(symbol);

  const realBook = await getRealOrderbook(sym, Number(depth));`,
    `  const { symbol, depth = 100 } = parsed.data;
  const sym = normalizeSymbol(symbol);
  const foregroundKey = foregroundRestKey(req);
  const foregroundCached = getForegroundRestCache(foregroundKey);
  if (foregroundCached) {
    sendForegroundRestCache(res, foregroundCached);
    return;
  }
  live.touchSymbol(sym);

  const realBook = await getRealOrderbook(sym, Number(depth));`,
    'orderbook foregroundCached',
    'orderbook foreground microcache lookup',
  );

  text = replaceText(
    text,
    `  res.json({
    symbol: sym,
    exchange,
    bids: obBids,
    asks: obAsks,
    spread,
    spreadPct: parseFloat(spreadPct.toFixed(4)),
    updatedAt: new Date().toISOString(),
  });`,
    `  const payload = {
    symbol: sym,
    exchange,
    bids: obBids,
    asks: obAsks,
    spread,
    spreadPct: parseFloat(spreadPct.toFixed(4)),
    updatedAt: new Date().toISOString(),
  };
  res.setHeader("X-Foreground-Rest-Cache", "MISS");
  setForegroundRestCache(foregroundKey, 200, payload, { "X-Foreground-Rest-Cache": "HIT" });
  res.json(payload);`,
    'orderbook setForegroundRestCache',
    'orderbook foreground microcache store',
  );

  return text;
});

console.log('[background-workload-patch] complete');
