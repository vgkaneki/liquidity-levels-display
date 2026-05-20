const fs = require('fs');
const file = 'artifacts/liquidity-heatmap/src/components/heatmap/HeatmapChart.tsx';
let src = fs.readFileSync(file, 'utf8');

if (!src.includes('structuralZonesRenderNudgeV1')) {
  const find = `  // Analytics overlays are read via refs inside renderChart, so kick a fresh
  // frame whenever a new tick arrives from the server or any toggle flips.
  useEffect(() => { scheduleRender(); }, [
    analyticsData,
    magnetClusters,
    realLiqClusters,
    overlayCfg.funding,
    overlayCfg.oiDelta,
    overlayCfg.takerPressure,
    overlayCfg.cvd,
    overlayCfg.magnetZones,
    scheduleRender,
  ]);

  // Mount-only: ResizeObserver and countdown timer.`;

  const replacement = `  // Analytics overlays are read via refs inside renderChart, so kick a fresh
  // frame whenever a new tick arrives from the server or any toggle flips.
  useEffect(() => { scheduleRender(); }, [
    analyticsData,
    magnetClusters,
    realLiqClusters,
    overlayCfg.funding,
    overlayCfg.oiDelta,
    overlayCfg.takerPressure,
    overlayCfg.cvd,
    overlayCfg.magnetZones,
    scheduleRender,
  ]);

  // structuralZonesRenderNudgeV1: structural zones are read through refs inside
  // renderChart, so redraw the canvas as soon as async structural data arrives.
  useEffect(() => { scheduleRender(); }, [
    structuralZones.length,
    structuralZones[0]?.priceLow,
    structuralZones[0]?.priceHigh,
    structuralZones[0]?.score,
    structuralUnsupported,
    sl.enabled,
    sl.confluenceOnly,
    sl.minConfidence,
    sl.fillOpacity,
    scheduleRender,
  ]);

  // Mount-only: ResizeObserver and countdown timer.`;

  if (!src.includes(find)) {
    console.log('[chart-structural-redraw-patch] skipped target not found');
  } else {
    src = src.replace(find, replacement);
    fs.writeFileSync(file, src);
    console.log('[chart-structural-redraw-patch] applied structuralZonesRenderNudgeV1');
  }
} else {
  console.log('[chart-structural-redraw-patch] already applied');
}
