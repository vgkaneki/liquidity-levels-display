const fs = require('fs');

function patchFile(file, applyPatch) {
  let src = fs.readFileSync(file, 'utf8');
  const next = applyPatch(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function replaceOnce(src, find, replace, marker, label) {
  if (marker && src.includes(marker)) {
    console.log(`[level-engine-bugfixes] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[level-engine-bugfixes] skipped ${label}`);
    return src;
  }
  console.log(`[level-engine-bugfixes] applied ${label}`);
  return src.replace(find, replace);
}

patchFile('artifacts/api-server/src/services/levelRegistry/index.ts', (src) => {
  src = replaceOnce(
    src,
    `const MIN_STRENGTH = 0.05;`,
    `const MIN_STRENGTH = 0.05;

// intervalScopedRegistryV1: keep confirmations/decay isolated per timeframe
// while preserving the public symbol-level API by aggregating all interval
// buckets for display. This prevents 1m/5m/15m/1H refreshes from weakening
// each other's levels.
function normalizeIntervalScope(interval?: string): string {
  const v = (interval ?? "default").trim().toLowerCase();
  return v || "default";
}`,
    'intervalScopedRegistryV1',
    'registry interval scope helper',
  );

  src = replaceOnce(
    src,
    `  recordZones(symbol: string, zones: StructuralZone[]): void {
    const now = Date.now();`,
    `  recordZones(symbol: string, zones: StructuralZone[], interval?: string): void {
    const now = Date.now();
    const intervalScope = normalizeIntervalScope(interval);
    const idPrefix = `${symbol}:${intervalScope}:`;`,
    'intervalScope = normalizeIntervalScope',
    'recordZones interval argument',
  );

  src = replaceOnce(
    src,
    '      const id = `${symbol}:${side}:${quantizePrice(price)}`;',
    '      const id = `${symbol}:${intervalScope}:${side}:${quantizePrice(price)}`;',
    '${intervalScope}:${side}',
    'interval-aware registry id',
  );

  src = replaceOnce(
    src,
    `      if (seen.has(id)) continue;`,
    `      if (!id.startsWith(idPrefix)) continue;
      if (seen.has(id)) continue;`,
    'id.startsWith(idPrefix)',
    'decay only current interval bucket',
  );

  return src;
});

patchFile('artifacts/api-server/src/routes/index.ts', (src) => {
  src = replaceOnce(
    src,
    `  if (rawInterval) {
    url.searchParams.set("interval", normalizeInterval(rawInterval));
    mutated = true;
  }`,
    `  if (rawInterval) {
    const normalizedInterval = normalizeInterval(rawInterval);
    url.searchParams.set("interval", normalizedInterval);
    res.locals.levelsInterval = normalizedInterval;
    mutated = true;
  }`,
    'res.locals.levelsInterval',
    'capture normalized levels interval',
  );

  src = replaceOnce(
    src,
    `        levelRegistry.recordZones(
          perpSym,
          (body as { zones: Parameters<typeof levelRegistry.recordZones>[1] }).zones,
        );`,
    `        levelRegistry.recordZones(
          perpSym,
          (body as { zones: Parameters<typeof levelRegistry.recordZones>[1] }).zones,
          res.locals.levelsInterval as string | undefined,
        );`,
    'res.locals.levelsInterval as string | undefined',
    'pass interval into registry',
  );

  return src;
});

patchFile('artifacts/api-server/src/services/engines/levels.ts', (src) => {
  src = replaceOnce(
    src,
    `    detectionIndex?: number;
    staleBars?: number;`,
    `    detectionIndex?: number;
    staleBars?: number;
    kind?: "support" | "resistance" | "neutral";`,
    'kind?: "support" | "resistance" | "neutral"',
    'validateLevel direction option',
  );

  src = replaceOnce(
    src,
    `  const minMove = Math.max(tol * 2, atr * 0.75);`,
    `  const minMove = Math.max(tol * 2, atr * 0.75);
  const bounceKind = opts?.kind;`,
    'const bounceKind = opts?.kind',
    'capture bounce direction',
  );

  src = replaceOnce(
    src,
    `        if (Math.abs(clean[j]!.close - refClose) > minMove) {
          moved = true;
          break;
        }`,
    `        const delta = clean[j]!.close - refClose;
        const bounced =
          bounceKind === "support"
            ? delta > minMove
            : bounceKind === "resistance"
              ? delta < -minMove
              : Math.abs(delta) > minMove;
        if (bounced) {
          moved = true;
          break;
        }`,
    'const bounced =',
    'direction-aware bounce test',
  );

  return src;
});

patchFile('artifacts/api-server/src/services/orchestrator.ts', (src) => {
  src = replaceOnce(
    src,
    `  const pivots = findPivots(ohlcv, 3);
  const reversalPrices = [
    ...pivots.highs.map((b) => b.high),
    ...pivots.lows.map((b) => b.low),
  ];`,
    `  const pivots = findPivots(ohlcv, 3);
  const timeToIdx = new Map<number, number>();
  for (let i = 0; i < ohlcv.length; i++) timeToIdx.set(ohlcv[i]!.time, i);
  const idxOf = (b: { time: number }): number => timeToIdx.get(b.time) ?? -1;
  const chronoPivots: Array<{ idx: number; price: number; kind: "high" | "low" }> = [
    ...pivots.highs.map((b) => ({ idx: idxOf(b), price: b.high, kind: "high" as const })),
    ...pivots.lows.map((b) => ({ idx: idxOf(b), price: b.low, kind: "low" as const })),
  ].sort((a, b) => a.idx - b.idx);
  const reversalPrices = chronoPivots.map((p) => p.price);`,
    'const chronoPivots: Array<{ idx: number; price: number; kind: "high" | "low" }> = [',
    'chronological HTF pivot weighting',
  );

  src = replaceOnce(
    src,
    `    const v = validateLevel(ohlcv, price, tolerance, 5, 2, { ...baseOpts, detectionIndex });
    rawLevels.push({
      price,
      method,
      kind: price < currentPrice ? "support" : "resistance",`,
    `    const kind = price < currentPrice ? "support" : "resistance";
    const v = validateLevel(ohlcv, price, tolerance, 5, 2, { ...baseOpts, detectionIndex, kind });
    rawLevels.push({
      price,
      method,
      kind,`,
    'detectionIndex, kind',
    'pass direction into validation',
  );

  src = replaceOnce(
    src,
    `    liquidations,
    ai,`,
    `    // These are theoretical leverage-distance bands, not real exchange
    // liquidation events. Real Binance/Bybit/OKX/HL liquidation streams live
    // in the liquidity routes.
    liquidations,
    theoreticalLiquidations: liquidations,
    liquidationsSource: "synthetic-leverage-bands" as const,
    ai,`,
    'liquidationsSource: "synthetic-leverage-bands"',
    'label theoretical liquidation bands',
  );

  return src;
});

patchFile('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', (src) => {
  src = replaceOnce(
    src,
    `  liquidations?: Array<{ price: number; density: number; leverage: number }>;
  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;`,
    `  liquidations?: Array<{ price: number; density: number; leverage: number }>;
  theoreticalLiquidations?: Array<{ price: number; density: number; leverage: number }>;
  liquidationsSource?: "synthetic-leverage-bands" | "real-exchange-events";
  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;`,
    'liquidationsSource?: "synthetic-leverage-bands"',
    'frontend liquidation source typing',
  );

  return src;
});

console.log('[level-engine-bugfixes] complete');
