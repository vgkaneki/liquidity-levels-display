// Hurst exponent (R/S analysis) and a simplified GARCH(1,1) volatility regime.

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (finite(a) && finite(b) && a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function cleanSeries(series: number[]): number[] {
  return series.filter((x) => finite(x));
}

function rescaledRange(series: number[]): number {
  const clean = cleanSeries(series);
  const n = clean.length;
  if (n < 4) return 0;
  const mean = clean.reduce((s, x) => s + x, 0) / n;
  const dev = clean.map((x) => x - mean);
  const cum: number[] = [];
  let acc = 0;
  for (const d of dev) { acc += d; cum.push(acc); }
  const range = Math.max(...cum) - Math.min(...cum);
  const variance = dev.reduce((s, d) => s + d * d, 0) / n;
  const stdev = Math.sqrt(Math.max(variance, 0));
  if (!finite(range) || !finite(stdev) || stdev === 0) return 0;
  return range / stdev;
}

export function hurstExponent(returns: number[]): number {
  const clean = cleanSeries(returns);
  if (clean.length < 64) return 0.5;
  const minLen = 8;
  const maxLen = Math.floor(clean.length / 2);
  const points: Array<[number, number]> = [];
  for (let len = minLen; len <= maxLen;) {
    const chunks = Math.floor(clean.length / len);
    if (chunks >= 1) {
      let total = 0;
      let count = 0;
      for (let i = 0; i < chunks; i++) {
        const slice = clean.slice(i * len, (i + 1) * len);
        const rs = rescaledRange(slice);
        if (rs > 0 && finite(rs)) { total += rs; count++; }
      }
      if (count > 0) points.push([Math.log(len), Math.log(total / count)]);
    }
    const nextLen = Math.floor(len * 1.6);
    len = nextLen > len ? nextLen : len + 1;
  }
  if (points.length < 3) return 0.5;
  const n = points.length;
  const sumX = points.reduce((s, [x]) => s + x, 0);
  const sumY = points.reduce((s, [, y]) => s + y, 0);
  const sumXY = points.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = points.reduce((s, [x]) => s + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0.5;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return finite(slope) ? Math.max(0, Math.min(1, slope)) : 0.5;
}

export function regimeFromHurst(h: number): { label: string; multiplier: number } {
  const safeH = finite(h) ? h : 0.5;
  if (safeH < 0.45) return { label: "mean-reverting", multiplier: 1.4 };
  if (safeH > 0.55) return { label: "trending", multiplier: 0.7 };
  return { label: "random", multiplier: 1.0 };
}

// Simplified GARCH(1,1) — fit with fixed reasonable params, then forecast.
export function garchVolatility(returns: number[]): number {
  const clean = cleanSeries(returns);
  if (clean.length < 30) return 0;
  const mean = clean.reduce((s, x) => s + x, 0) / clean.length;
  const dev = clean.map((x) => x - mean);
  const omega = 0.000001;
  const alpha = 0.08;
  const beta = 0.9;
  let v = dev.reduce((s, d) => s + d * d, 0) / dev.length;
  if (!finite(v) || v < 0) return 0;
  for (const d of dev) {
    v = omega + alpha * d * d + beta * v;
    if (!finite(v) || v < 0) return 0;
  }
  const out = Math.sqrt(v);
  return finite(out) ? out : 0;
}

export function garchRegime(currentVol: number, history: number[]): string {
  const clean = cleanSeries(history).filter((x) => x >= 0);
  if (clean.length < 30 || !finite(currentVol)) return "normal";
  const sorted = [...clean].sort((a, b) => a - b);
  const p33 = sorted[Math.floor(sorted.length * 0.33)] ?? 0;
  const p66 = sorted[Math.floor(sorted.length * 0.66)] ?? Infinity;
  if (currentVol < p33) return "low";
  if (currentVol > p66) return "high";
  return "normal";
}

// Build a rolling history of GARCH vols for regime classification.
export function rollingGarchHistory(returns: number[], window = 50): number[] {
  const clean = cleanSeries(returns);
  const safeWindow = finite(window) ? Math.max(1, Math.floor(window)) : 50;
  const out: number[] = [];
  for (let i = safeWindow; i <= clean.length; i++) {
    out.push(garchVolatility(clean.slice(i - safeWindow, i)));
  }
  return out;
}
