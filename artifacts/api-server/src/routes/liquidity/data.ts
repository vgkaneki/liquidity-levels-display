import type { HeatLevel, OrderbookLevel } from "./types";

// Live-only orderbook + heatmap math. The historical synthetic catalog
// (KNOWN_MARKETS, the per-symbol catalog, buildSyntheticOrderbook, getSymbolDataList,
// MAJOR_SYMBOLS, getSimulatedPrice, seededRandom) was removed in Task #103
// — every route now sources its bids/asks/tickers from the real exchange
// adapters and returns 503 when no live data is available.

function getRoundStep(price: number): number {
  if (price >= 50000) return 1000;
  if (price >= 5000) return 500;
  if (price >= 500) return 50;
  if (price >= 50) return 5;
  if (price >= 5) return 0.5;
  if (price >= 0.5) return 0.05;
  return 0.005;
}

export function buildHeatLevels(
  bids: [number, number][],
  asks: [number, number][],
  markPrice: number,
  numLevels: number
): HeatLevel[] {
  const allPrices = [...bids.map(([p]) => p), ...asks.map(([p]) => p)];
  if (allPrices.length === 0) return [];

  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const range = maxPrice - minPrice;
  if (range === 0) return [];

  const bucketSize = range / numLevels;

  const levels: HeatLevel[] = Array.from({ length: numLevels }, (_, i) => ({
    price: minPrice + i * bucketSize + bucketSize / 2,
    bidSize: 0,
    askSize: 0,
    totalSize: 0,
    heatScore: 0,
    isLiquidationCluster: false,
    imbalanceRatio: 0,
    proximityScore: 0,
    roundNumberBonus: 0,
    liqDensity: 0,
    compositeScore: 0,
  }));

  for (const [price, size] of bids) {
    const idx = Math.min(
      Math.floor((price - minPrice) / bucketSize),
      numLevels - 1
    );
    if (levels[idx]) {
      levels[idx].bidSize += size;
      levels[idx].totalSize += size;
    }
  }

  for (const [price, size] of asks) {
    const idx = Math.min(
      Math.floor((price - minPrice) / bucketSize),
      numLevels - 1
    );
    if (levels[idx]) {
      levels[idx].askSize += size;
      levels[idx].totalSize += size;
    }
  }

  const maxTotal = Math.max(...levels.map((l) => l.totalSize));
  const roundStep = getRoundStep(markPrice);

  for (const level of levels) {
    level.heatScore = maxTotal > 0 ? level.totalSize / maxTotal : 0;

    const priceDist = Math.abs(level.price - markPrice) / markPrice;

    level.isLiquidationCluster =
      level.heatScore > 0.5 && priceDist > 0.005 && priceDist < 0.08;

    level.imbalanceRatio = level.totalSize > 0
      ? Math.abs(level.bidSize - level.askSize) / level.totalSize
      : 0;

    level.proximityScore = 1 / (1 + priceDist * 40);

    const distToRound = Math.abs(level.price % roundStep);
    const roundProximity = Math.min(distToRound, roundStep - distToRound) / roundStep;
    level.roundNumberBonus = roundProximity < 0.08 ? 1.0 : roundProximity < 0.15 ? 0.4 : 0;

    level.liqDensity = level.isLiquidationCluster
      ? 0.7 + level.heatScore * 0.3
      : level.heatScore > 0.35 && priceDist > 0.003
        ? 0.3 + level.heatScore * 0.3
        : 0;

    const W_ORDERBOOK = 0.30;
    const W_LIQ = 0.25;
    const W_PROXIMITY = 0.20;
    const W_ROUND = 0.15;
    const W_IMBALANCE = 0.10;

    level.compositeScore =
      level.heatScore * W_ORDERBOOK +
      level.liqDensity * W_LIQ +
      level.proximityScore * W_PROXIMITY +
      level.roundNumberBonus * W_ROUND +
      level.imbalanceRatio * W_IMBALANCE;
  }

  const maxComposite = Math.max(...levels.map((l) => l.compositeScore));
  if (maxComposite > 0) {
    for (const level of levels) {
      level.compositeScore = level.compositeScore / maxComposite;
    }
  }

  return levels.sort((a, b) => b.price - a.price);
}

export function buildOrderbookLevels(
  rawLevels: [number, number][]
): OrderbookLevel[] {
  let cumulative = 0;
  return rawLevels.map(([price, size]) => {
    cumulative += size;
    return { price, size, cumulative, count: 1 };
  });
}
