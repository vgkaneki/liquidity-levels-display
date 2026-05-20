export interface HeatLevel {
  price: number;
  bidSize: number;
  askSize: number;
  totalSize: number;
  heatScore: number;
  isLiquidationCluster: boolean;
  imbalanceRatio: number;
  proximityScore: number;
  roundNumberBonus: number;
  liqDensity: number;
  compositeScore: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  cumulative: number;
  count: number;
}

export interface Symbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  markPrice: number;
  priceChange24h: number;
  volume24h: number;
  openInterest: number;
  liquidityScore: number;
}
