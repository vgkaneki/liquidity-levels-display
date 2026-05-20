export interface PlotTransformLike {
  chartW: number;
  chartH: number;
  minPrice: number;
  maxPrice: number;
  priceRange: number;
  useLog: boolean;
  logMin: number;
  logRange: number;
}

export function priceToYFromTransform(tx: PlotTransformLike, price: number): number {
  if (tx.useLog && price > 0) {
    return (1 - (Math.log(price) - tx.logMin) / tx.logRange) * tx.chartH;
  }
  return (1 - (price - tx.minPrice) / tx.priceRange) * tx.chartH;
}

export function yToPriceFromTransform(tx: PlotTransformLike, y: number): number {
  const clampedY = Math.max(0, Math.min(tx.chartH, y));
  const pct = 1 - clampedY / Math.max(1, tx.chartH);
  if (tx.useLog) return Math.exp(tx.logMin + pct * tx.logRange);
  return tx.minPrice + pct * tx.priceRange;
}

export function clampChartPriceRange(minPrice: number, maxPrice: number, candleLow: number): { minPrice: number; maxPrice: number } {
  let lo = minPrice;
  let hi = maxPrice;
  if (lo < candleLow * 0.01) lo = candleLow * 0.01;
  if (hi - lo < 1e-9) hi = lo + Math.max(1e-9, candleLow * 1e-6);
  return { minPrice: lo, maxPrice: hi };
}
