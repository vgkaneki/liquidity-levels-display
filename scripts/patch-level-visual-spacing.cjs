const fs = require('fs');

const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[level-visual-spacing-patch] already applied ${label}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[level-visual-spacing-patch] skipped ${label}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[level-visual-spacing-patch] applied ${label}`);
}

const insertBefore = `    // Publish current visible levels so the settings dialog can show them.`;
const spacingBlock = [
  '    // visualLevelSpacingV1: display compaction only. Keep every real engine',
  '    // level intact, but render a clean representative set so mobile zoom does',
  '    // not collapse many nearby levels into a crowded band. This is based on',
  '    // screen Y-spacing after price mapping; it does NOT recalculate, delete,',
  '    // rescore, retier, or mutate protected engine levels.',
  '    if (lines.length > 1) {',
  '      const minPixelGap = compact',
  '        ? 18',
  '        : Math.max(18, Math.min(36, Number(import.meta.env.VITE_LEVEL_MIN_PIXEL_GAP ?? "26") || 26));',
  '      const maxPerSide = compact',
  '        ? 3',
  '        : Math.max(3, Math.min(8, Number(import.meta.env.VITE_LEVEL_MAX_VISIBLE_PER_SIDE ?? "5") || 5));',
  '      const zonesForPriority = structuralZonesRef.current ?? [];',
  '      const hasSideConfluence = (l: LiquidityLine): boolean =>',
  '        zonesForPriority.some((z) =>',
  '          l.price >= z.priceLow &&',
  '          l.price <= z.priceHigh &&',
  '          (l.isBid ? z.kind === "support" : z.kind === "resistance"),',
  '        );',
  '      const priority = (l: LiquidityLine): number => {',
  '        const tierBoost = l.tier === "elite" ? 60 : l.tier === "strong" ? 32 : 0;',
  '        const confBoost = hasSideConfluence(l) ? 45 : 0;',
  '        const touchBoost = Math.min(12, Math.max(0, l.touchCount)) * 3;',
  '        const reliabilityBoost = Math.max(0, Math.min(1, l.reliability)) * 35;',
  '        return tierBoost + confBoost + touchBoost + reliabilityBoost + l.strength * 100;',
  '      };',
  '      const candidates = lines',
  '        .map((line) => ({ line, y: Math.round(priceToY(line.price)), score: priority(line) }))',
  '        .sort((a, b) => b.score - a.score);',
  '      const selected: typeof candidates = [];',
  '      const sideCounts = { bid: 0, ask: 0 };',
  '      for (const item of candidates) {',
  '        const side = item.line.isBid ? "bid" : "ask";',
  '        if (sideCounts[side] >= maxPerSide) continue;',
  '        const collides = selected.some((kept) => Math.abs(kept.y - item.y) < minPixelGap);',
  '        if (collides) continue;',
  '        selected.push(item);',
  '        sideCounts[side] += 1;',
  '      }',
  '      if (selected.length > 0) {',
  '        lines = selected',
  '          .sort((a, b) => a.line.price - b.line.price)',
  '          .map((item) => item.line);',
  '      }',
  '    }',
  '',
].join('\n');

apply(
  insertBefore,
  `${spacingBlock}${insertBefore}`,
  'visualLevelSpacingV1',
  'mobile-friendly visual level spacing',
);

fs.writeFileSync(file, src);
console.log('[level-visual-spacing-patch] complete');
