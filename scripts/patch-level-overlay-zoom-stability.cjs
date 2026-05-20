const fs = require('fs');

const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[level-overlay-zoom-stability-patch] already applied ${label}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[level-overlay-zoom-stability-patch] skipped ${label}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[level-overlay-zoom-stability-patch] applied ${label}`);
}

apply(
`  const renderedLevelsRef = useRef<Array<{ price: number; y: number; isBid: boolean; tier: "elite" | "strong" | "normal" }>>([]);
  const containerRef = useRef<HTMLDivElement>(null);`,
`  const renderedLevelsRef = useRef<Array<{ price: number; y: number; isBid: boolean; tier: "elite" | "strong" | "normal" }>>([]);
  // levelOverlayZoomStabilityV1: zoom/pan must only transform already-discovered
  // levels; it must not cause the chart to recompute, decay, retier, or replace
  // the overlay set. The cache key below intentionally excludes viewport bounds.
  // Display-only stability; protected engine formulas and scoring untouched.
  const stableLevelOverlayRef = useRef<{ key: string; lines: LiquidityLine[] } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);`,
'levelOverlayZoomStabilityV1',
'stable overlay ref',
);

const oldBlock = [
'    // ============ LIQUIDITY LINES ============',
'    // Use 1H + 4H anchor candles for level analysis so levels stay fixed',
'    // regardless of which timeframe the chart is currently displaying.',
'    // Fall back to display candles only if anchors haven\'t loaded yet.',
'    const levelCandles = anchorCandles ?? candles;',
'    // Detect levels across a wide ±8% band around mark price (matching',
'    // REMOVAL_DISTANCE) so far-away majors enter the registry. The chart',
'    // itself only renders those that fall within the visible window.',
'    const detectLo = data.markPrice * (1 - REMOVAL_DISTANCE);',
'    const detectHi = data.markPrice * (1 + REMOVAL_DISTANCE);',
'    const freshLines = extractLiquidityLines(data, detectLo, detectHi, data.markPrice, levelCandles, liqSamples);',
'    let merged = mergeAndPersistLevels(chartSymbol, freshLines, data.markPrice, levelCandles);',
'    // UNION with persistent registry: always merge the long-term registry',
'    // levels into the working set so structural majors (recorded across',
'    // hours/days) remain visible regardless of how many lines the local',
'    // extractor produced this frame. Without this, a tightly-clustered',
'    // heatmap payload can collapse to ~1 local line and silently suppress',
'    // the registry\'s structural majors. Dedup by visualTol so we never',
'    // double-up on a price that the local extractor already accepted —',
'    // local takes precedence (it carries fresher strength/touch counts).',
'    if (registryLevelsRef.current.length > 0) {',
'      const unionTol = data.markPrice * VISUAL_CONSOLIDATE_FACTOR;',
'      const registryProjected = registryLevelsRef.current',
'        .filter((l) => l.price >= detectLo && l.price <= detectHi)',
'        .map<LiquidityLine>((l) => ({',
'          price: l.price,',
'          strength: Math.min(1, Math.max(0, l.strength)),',
'          isBid: l.side === "support",',
'          tier: l.tier >= 3 ? "elite" : l.tier === 2 ? "strong" : "normal",',
'          touchCount: l.touches,',
'          winRate: 0,',
'          reliability: l.reliability,',
'        }));',
'      const additions: LiquidityLine[] = [];',
'      for (const reg of registryProjected) {',
'        let collides = false;',
'        for (const existing of merged) {',
'          if (Math.abs(existing.price - reg.price) <= unionTol) { collides = true; break; }',
'        }',
'        if (!collides) additions.push(reg);',
'      }',
'      if (additions.length > 0) merged = merged.concat(additions);',
'    }',
'    // Final visual de-cluster pass — collapse adjacent lines that ended up',
'    // within VISUAL_CONSOLIDATE_FACTOR of each other so the chart shows',
'    // the strongest representative level instead of overlapping horizontals.',
'    // Users can still hand-curate via Settings → Liquidity → Visible levels list.',
'    const visualTol = data.markPrice * VISUAL_CONSOLIDATE_FACTOR;',
'    const sorted = [...merged].sort((a, b) => a.price - b.price);',
'    const consolidated: LiquidityLine[] = [];',
'    for (const lvl of sorted) {',
'      const last = consolidated[consolidated.length - 1];',
'      if (last && Math.abs(lvl.price - last.price) <= visualTol) {',
'        const dominant = lvl.strength > last.strength ? lvl : last;',
'        const weaker = dominant === lvl ? last : lvl;',
'        dominant.strength = Math.min(1, dominant.strength + weaker.strength * 0.2);',
'        dominant.touchCount = Math.max(dominant.touchCount, weaker.touchCount);',
'        dominant.reliability = Math.max(dominant.reliability, weaker.reliability);',
'        dominant.tier = dominant.tier === "elite" || weaker.tier === "elite"',
'          ? "elite"',
'          : (dominant.tier === "strong" || weaker.tier === "strong" ? "strong" : "normal");',
'        consolidated[consolidated.length - 1] = dominant;',
'      } else {',
'        consolidated.push({ ...lvl });',
'      }',
'    }',
].join('\n');

const newBlock = [
'    // ============ LIQUIDITY LINES ============',
'    // levelOverlayZoomStabilityV1: level discovery is anchored to stable',
'    // candle context, never to the current zoom/pan viewport. Zooming should',
'    // only remap price→Y; it must not replace/retier/decay levels. Use 1H+4H',
'    // anchors when ready, otherwise the full current-interval candle store —',
'    // not the visible `candles` slice.',
'    const levelCandles = anchorCandles ?? allCandles;',
'    const detectLo = data.markPrice * (1 - REMOVAL_DISTANCE);',
'    const detectHi = data.markPrice * (1 + REMOVAL_DISTANCE);',
'    const dataLevelsForKey = data.levels ?? [];',
'    const firstDataLevel = dataLevelsForKey[0];',
'    const lastDataLevel = dataLevelsForKey[dataLevelsForKey.length - 1];',
'    const overlayKey = [',
'      normalizeSymbolKey(chartSymbol),',
'      Math.round(data.markPrice * 10000) / 10000,',
'      dataLevelsForKey.length,',
'      firstDataLevel ? Number(firstDataLevel.price).toFixed(6) : "none",',
'      lastDataLevel ? Number(lastDataLevel.price).toFixed(6) : "none",',
'      levelCandles.length,',
'      anchorCandles ? "anchor" : "display",',
'      registryLevelsRef.current.length,',
'      liqSamples.length,',
'    ].join("|");',
'',
'    let consolidated =',
'      stableLevelOverlayRef.current?.key === overlayKey',
'        ? stableLevelOverlayRef.current.lines',
'        : null;',
'',
'    if (!consolidated) {',
'      const freshLines = extractLiquidityLines(data, detectLo, detectHi, data.markPrice, levelCandles, liqSamples);',
'      let merged = mergeAndPersistLevels(chartSymbol, freshLines, data.markPrice, levelCandles);',
'      // UNION with persistent registry: always merge the long-term registry',
'      // levels into the working set so structural majors remain visible.',
'      if (registryLevelsRef.current.length > 0) {',
'        const unionTol = data.markPrice * VISUAL_CONSOLIDATE_FACTOR;',
'        const registryProjected = registryLevelsRef.current',
'          .filter((l) => l.price >= detectLo && l.price <= detectHi)',
'          .map<LiquidityLine>((l) => ({',
'            price: l.price,',
'            strength: Math.min(1, Math.max(0, l.strength)),',
'            isBid: l.side === "support",',
'            tier: l.tier >= 3 ? "elite" : l.tier === 2 ? "strong" : "normal",',
'            touchCount: l.touches,',
'            winRate: 0,',
'            reliability: l.reliability,',
'          }));',
'        const additions: LiquidityLine[] = [];',
'        for (const reg of registryProjected) {',
'          let collides = false;',
'          for (const existing of merged) {',
'            if (Math.abs(existing.price - reg.price) <= unionTol) { collides = true; break; }',
'          }',
'          if (!collides) additions.push(reg);',
'        }',
'        if (additions.length > 0) merged = merged.concat(additions);',
'      }',
'      const visualTol = data.markPrice * VISUAL_CONSOLIDATE_FACTOR;',
'      const sorted = [...merged].sort((a, b) => a.price - b.price);',
'      consolidated = [];',
'      for (const lvl of sorted) {',
'        const last = consolidated[consolidated.length - 1];',
'        if (last && Math.abs(lvl.price - last.price) <= visualTol) {',
'          const dominant = lvl.strength > last.strength ? { ...lvl } : { ...last };',
'          const weaker = dominant.price === lvl.price ? last : lvl;',
'          dominant.strength = Math.min(1, dominant.strength + weaker.strength * 0.2);',
'          dominant.touchCount = Math.max(dominant.touchCount, weaker.touchCount);',
'          dominant.reliability = Math.max(dominant.reliability, weaker.reliability);',
'          dominant.tier = dominant.tier === "elite" || weaker.tier === "elite"',
'            ? "elite"',
'            : (dominant.tier === "strong" || weaker.tier === "strong" ? "strong" : "normal");',
'          consolidated[consolidated.length - 1] = dominant;',
'        } else {',
'          consolidated.push({ ...lvl });',
'        }',
'      }',
'      stableLevelOverlayRef.current = { key: overlayKey, lines: consolidated };',
'    }',
].join('\n');

apply(
  oldBlock,
  newBlock,
  'const overlayKey = [',
  'zoom-stable level computation',
);

fs.writeFileSync(file, src);
console.log('[level-overlay-zoom-stability-patch] complete');
