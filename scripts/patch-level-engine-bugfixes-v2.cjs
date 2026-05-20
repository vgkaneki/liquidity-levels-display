const fs = require('fs');

function edit(file, fn) {
  let s = fs.readFileSync(file, 'utf8');
  const n = fn(s);
  if (n !== s) fs.writeFileSync(file, n);
}
function once(s, a, b, m) {
  if (s.includes(m)) return s;
  if (!s.includes(a)) { console.log('[level-bugfix-v2] skipped', m); return s; }
  console.log('[level-bugfix-v2] applied', m);
  return s.replace(a, b);
}

edit('artifacts/api-server/src/services/levelRegistry/index.ts', (s) => {
  s = once(s,
    'const MIN_STRENGTH = 0.05;',
    [
      'const MIN_STRENGTH = 0.05;',
      '',
      '// intervalScopedRegistryV2: isolate registry confirm/decay per timeframe.',
      'function normalizeIntervalScope(interval?: string): string {',
      '  const v = (interval ?? "default").trim().toLowerCase();',
      '  return v || "default";',
      '}',
    ].join('\n'),
    'intervalScopedRegistryV2'
  );
  s = once(s,
    ['  recordZones(symbol: string, zones: StructuralZone[]): void {', '    const now = Date.now();'].join('\n'),
    [
      '  recordZones(symbol: string, zones: StructuralZone[], interval?: string): void {',
      '    const now = Date.now();',
      '    const intervalScope = normalizeIntervalScope(interval);',
      '    const idPrefix = `${symbol}:${intervalScope}:`;',
    ].join('\n'),
    'intervalScope = normalizeIntervalScope'
  );
  s = once(s,
    '      const id = `${symbol}:${side}:${quantizePrice(price)}`;',
    '      const id = `${symbol}:${intervalScope}:${side}:${quantizePrice(price)}`;',
    '${intervalScope}:${side}'
  );
  s = once(s,
    '      if (seen.has(id)) continue;',
    ['      if (!id.startsWith(idPrefix)) continue;', '      if (seen.has(id)) continue;'].join('\n'),
    'id.startsWith(idPrefix)'
  );
  return s;
});

edit('artifacts/api-server/src/routes/index.ts', (s) => {
  s = once(s,
    ['  if (rawInterval) {', '    url.searchParams.set("interval", normalizeInterval(rawInterval));', '    mutated = true;', '  }'].join('\n'),
    ['  if (rawInterval) {', '    const normalizedInterval = normalizeInterval(rawInterval);', '    url.searchParams.set("interval", normalizedInterval);', '    res.locals.levelsInterval = normalizedInterval;', '    mutated = true;', '  }'].join('\n'),
    'res.locals.levelsInterval'
  );
  s = once(s,
    ['        levelRegistry.recordZones(', '          perpSym,', '          (body as { zones: Parameters<typeof levelRegistry.recordZones>[1] }).zones,', '        );'].join('\n'),
    ['        levelRegistry.recordZones(', '          perpSym,', '          (body as { zones: Parameters<typeof levelRegistry.recordZones>[1] }).zones,', '          res.locals.levelsInterval as string | undefined,', '        );'].join('\n'),
    'res.locals.levelsInterval as string | undefined'
  );
  return s;
});

edit('artifacts/api-server/src/services/engines/levels.ts', (s) => {
  s = once(s,
    ['    detectionIndex?: number;', '    staleBars?: number;'].join('\n'),
    ['    detectionIndex?: number;', '    staleBars?: number;', '    kind?: "support" | "resistance" | "neutral";'].join('\n'),
    'kind?: "support" | "resistance" | "neutral"'
  );
  s = once(s,
    '  const minMove = Math.max(tol * 2, atr * 0.75);',
    ['  const minMove = Math.max(tol * 2, atr * 0.75);', '  const bounceKind = opts?.kind;'].join('\n'),
    'const bounceKind = opts?.kind'
  );
  s = once(s,
    ['        if (Math.abs(clean[j]!.close - refClose) > minMove) {', '          moved = true;', '          break;', '        }'].join('\n'),
    ['        const delta = clean[j]!.close - refClose;', '        const bounced =', '          bounceKind === "support"', '            ? delta > minMove', '            : bounceKind === "resistance"', '              ? delta < -minMove', '              : Math.abs(delta) > minMove;', '        if (bounced) {', '          moved = true;', '          break;', '        }'].join('\n'),
    'const bounced ='
  );
  return s;
});

edit('artifacts/api-server/src/services/orchestrator.ts', (s) => {
  s = once(s,
    ['  const pivots = findPivots(ohlcv, 3);', '  const reversalPrices = [', '    ...pivots.highs.map((b) => b.high),', '    ...pivots.lows.map((b) => b.low),', '  ];'].join('\n'),
    ['  const pivots = findPivots(ohlcv, 3);', '  const timeToIdx = new Map<number, number>();', '  for (let i = 0; i < ohlcv.length; i++) timeToIdx.set(ohlcv[i]!.time, i);', '  const idxOf = (b: { time: number }): number => timeToIdx.get(b.time) ?? -1;', '  const chronoPivots: Array<{ idx: number; price: number; kind: "high" | "low" }> = [', '    ...pivots.highs.map((b) => ({ idx: idxOf(b), price: b.high, kind: "high" as const })),', '    ...pivots.lows.map((b) => ({ idx: idxOf(b), price: b.low, kind: "low" as const })),', '  ].sort((a, b) => a.idx - b.idx);', '  const reversalPrices = chronoPivots.map((p) => p.price);'].join('\n'),
    'const chronoPivots: Array<{ idx: number; price: number; kind: "high" | "low" }> = ['
  );
  s = once(s,
    ['    const v = validateLevel(ohlcv, price, tolerance, 5, 2, { ...baseOpts, detectionIndex });', '    rawLevels.push({', '      price,', '      method,', '      kind: price < currentPrice ? "support" : "resistance",'].join('\n'),
    ['    const kind = price < currentPrice ? "support" : "resistance";', '    const v = validateLevel(ohlcv, price, tolerance, 5, 2, { ...baseOpts, detectionIndex, kind });', '    rawLevels.push({', '      price,', '      method,', '      kind,'].join('\n'),
    'detectionIndex, kind'
  );
  s = once(s,
    ['    liquidations,', '    ai,'].join('\n'),
    ['    liquidations,', '    theoreticalLiquidations: liquidations,', '    liquidationsSource: "synthetic-leverage-bands" as const,', '    ai,'].join('\n'),
    'liquidationsSource: "synthetic-leverage-bands"'
  );
  return s;
});

edit('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', (s) => {
  s = once(s,
    ['  liquidations?: Array<{ price: number; density: number; leverage: number }>;', '  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;'].join('\n'),
    ['  liquidations?: Array<{ price: number; density: number; leverage: number }>;', '  theoreticalLiquidations?: Array<{ price: number; density: number; leverage: number }>;', '  liquidationsSource?: "synthetic-leverage-bands" | "real-exchange-events";', '  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;'].join('\n'),
    'liquidationsSource?: "synthetic-leverage-bands"'
  );
  return s;
});

console.log('[level-bugfix-v2] complete');
