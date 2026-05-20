import type { HlTrade, HlL2Book } from "../hyperliquid";

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function tradeSize(t: HlTrade): number | null {
  const sz = Number(t.sz);
  return finite(sz) && sz > 0 ? sz : null;
}

// VPIN — Volume-Synchronized Probability of Informed Trading
// Bucketize trades by volume; compute |buyVol-sellVol|/totalVol per bucket.
export function computeVpin(trades: HlTrade[], bucketSize: number, numBuckets = 50): number {
  const maxBuckets = finite(numBuckets) ? Math.max(1, Math.floor(numBuckets)) : 50;
  if (trades.length === 0 || !finite(bucketSize) || bucketSize <= 0) return 0;
  const buckets: Array<{ buy: number; sell: number }> = [];
  let cur = { buy: 0, sell: 0 };
  let curVol = 0;
  for (const t of trades) {
    const sz = tradeSize(t);
    if (sz === null) continue;
    if (t.side === "B") cur.buy += sz; else cur.sell += sz;
    curVol += sz;
    if (curVol >= bucketSize) {
      buckets.push(cur);
      cur = { buy: 0, sell: 0 };
      curVol = 0;
      if (buckets.length >= maxBuckets) break;
    }
  }
  if (buckets.length === 0) return 0;
  let sum = 0;
  for (const b of buckets) {
    const tot = b.buy + b.sell;
    if (tot > 0) sum += Math.abs(b.buy - b.sell) / tot;
  }
  const vpin = sum / buckets.length;
  return finite(vpin) ? Math.min(1, Math.max(0, vpin)) : 0;
}

// Order book imbalance — top N levels.
export function computeObi(book: HlL2Book, depth = 10): number {
  const levels = (book as { levels?: unknown }).levels;
  const bids = Array.isArray(levels) && Array.isArray(levels[0]) ? levels[0] as Array<{ sz?: unknown }> : [];
  const asks = Array.isArray(levels) && Array.isArray(levels[1]) ? levels[1] as Array<{ sz?: unknown }> : [];
  const safeDepth = finite(depth) ? Math.max(0, Math.floor(depth)) : 10;
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < Math.min(safeDepth, bids.length); i++) {
    const sz = Number(bids[i]?.sz ?? 0);
    if (finite(sz) && sz > 0) bidVol += sz;
  }
  for (let i = 0; i < Math.min(safeDepth, asks.length); i++) {
    const sz = Number(asks[i]?.sz ?? 0);
    if (finite(sz) && sz > 0) askVol += sz;
  }
  const tot = bidVol + askVol;
  if (tot === 0) return 0;
  const obi = (bidVol - askVol) / tot;
  return finite(obi) ? Math.max(-1, Math.min(1, obi)) : 0;
}

// Cumulative Volume Delta (CVD) per bar — buy minus sell aggressor volume.
export function bucketTradesByCandle(trades: HlTrade[], candleMs: number): Map<number, { buy: number; sell: number }> {
  const map = new Map<number, { buy: number; sell: number }>();
  if (!finite(candleMs) || candleMs <= 0) return map;
  for (const t of trades) {
    if (!finite(t.time)) continue;
    const sz = tradeSize(t);
    if (sz === null) continue;
    const bucket = Math.floor(t.time / candleMs) * candleMs;
    if (!finite(bucket)) continue;
    let agg = map.get(bucket);
    if (!agg) { agg = { buy: 0, sell: 0 }; map.set(bucket, agg); }
    if (t.side === "B") agg.buy += sz; else agg.sell += sz;
  }
  return map;
}
