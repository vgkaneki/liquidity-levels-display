export interface ChartLevelRenderPoint {
  price: number;
  y: number;
  side: "bid" | "ask";
  tier: "elite" | "strong" | "normal";
  label?: string;
}

// chartLevelRendererV1: extraction target for level-rendering helpers.
// This module is intentionally display-only. It must not contain liquidity,
// structural, confluence, scoring, touch-classification, DOM, Bookmap, or
// absorption formulas.
export function shouldRenderLevelLabel(compact: boolean, tier: ChartLevelRenderPoint["tier"]): boolean {
  if (!compact) return true;
  return tier === "elite";
}

export function levelHitTest(
  levels: ChartLevelRenderPoint[],
  y: number,
  tolerancePx = 6,
): ChartLevelRenderPoint | null {
  let best: ChartLevelRenderPoint | null = null;
  let bestDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(level.y - y);
    if (dist <= tolerancePx && dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}
