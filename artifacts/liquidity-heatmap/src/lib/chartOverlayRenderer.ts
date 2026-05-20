export interface OverlayRenderGateInput {
  compact: boolean;
  chartReady: boolean;
  overlayEnabled: boolean;
}

// chartOverlayRendererV1: extraction target for chart overlay render gating.
// Display/network scheduling only. This module must stay independent of
// liquidity/structural formulas, confluence, scoring, DOM, Bookmap,
// absorption, touch classification, and level placement rules.
export function shouldRenderChartOverlay(input: OverlayRenderGateInput): boolean {
  return Boolean(!input.compact && input.chartReady && input.overlayEnabled);
}

export function overlayOpacity(base: number, compact: boolean): number {
  const v = Number.isFinite(base) ? base : 1;
  return Math.max(0, Math.min(1, compact ? v * 0.65 : v));
}
