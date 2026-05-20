import { fetchCandles, intervalToLookbackMs, candlesToOhlcv } from "../hyperliquid";

// Cross-asset confirmation. Spec: rolling 90-day return correlation across the
// canonical perpetual majors. We sample daily candles (90 bars) and compute
// Pearson correlation of daily log returns for each pair, plus a ratio z-score
// for divergence detection.
const PAIRS: Array<[string, string]> = [
  ["BTC", "ETH"],
  ["BTC", "SOL"],
  ["ETH", "SOL"],
];

function logReturns(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1] ?? 0;
    const cur = xs[i] ?? 0;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const aT = a.slice(a.length - n);
  const bT = b.slice(b.length - n);
  const ma = aT.reduce((s, x) => s + x, 0) / n;
  const mb = bT.reduce((s, x) => s + x, 0) / n;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < n; i++) {
    const xa = (aT[i] ?? 0) - ma;
    const xb = (bT[i] ?? 0) - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db) || 1e-12;
  return num / denom;
}

export async function computeCrossPairZScores() {
  const bars = 90; // rolling 90-day window
  const interval = "1d";
  const lookback = intervalToLookbackMs(interval, bars);
  const symbols = Array.from(new Set(PAIRS.flat()));
  const series = new Map<string, number[]>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const candles = await fetchCandles(s, interval, lookback);
        series.set(s, candlesToOhlcv(candles).map((c) => c.close));
      } catch {
        series.set(s, []);
      }
    }),
  );
  const out = [];
  for (const [a, b] of PAIRS) {
    const sa = series.get(a) ?? [];
    const sb = series.get(b) ?? [];
    const n = Math.min(sa.length, sb.length);
    if (n < 30) continue;
    const aTrim = sa.slice(sa.length - n);
    const bTrim = sb.slice(sb.length - n);
    const correlation = pearson(logReturns(aTrim), logReturns(bTrim));
    const ratios: number[] = [];
    for (let i = 0; i < n; i++) {
      const va = aTrim[i] ?? 0,
        vb = bTrim[i] ?? 0;
      if (vb !== 0) ratios.push(va / vb);
    }
    if (ratios.length === 0) continue;
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const variance =
      ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length;
    const stdev = Math.sqrt(variance) || 1;
    const cur = ratios[ratios.length - 1] ?? mean;
    const z = (cur - mean) / stdev;
    let signal = "neutral";
    if (z > 2) signal = "expand";
    else if (z < -2) signal = "revert";
    out.push({
      pair: `${a}/${b}`,
      ratio: cur,
      meanRatio: mean,
      zScore: z,
      correlation,
      signal,
    });
  }
  return out;
}
