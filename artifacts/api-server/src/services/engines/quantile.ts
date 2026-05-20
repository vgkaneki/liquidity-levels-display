// Quantile regression bands.
//
// We fit a simple ordinary-least-squares trend line to recent closes and then
// take empirical quantiles of the residuals. The α and (1-α) quantile bands
// provide statistically meaningful price levels that adapt to the current
// trend slope. This is a pragmatic approximation of true quantile regression
// (which requires solving a linear program); for a single-feature trend the
// residual-quantile approximation is accurate enough for level estimation.

export interface QuantileBand {
  price: number;
  quantile: number; // 0..1
  band: "lower" | "upper";
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function quantileBands(
  closes: number[],
  quantiles: number[] = [0.05, 0.1, 0.9, 0.95],
): QuantileBand[] {
  const cleanCloses = closes.filter((x) => finite(x));
  const qs = quantiles
    .filter((q) => finite(q))
    .map((q) => Math.min(1, Math.max(0, q)));
  const n = cleanCloses.length;
  if (n < 20 || qs.length === 0) return [];
  // OLS fit y = a + b*x.
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += cleanCloses[i]!;
    sxy += i * cleanCloses[i]!;
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const lastIdx = n - 1;
  const trendNow = intercept + slope * lastIdx;
  if (!finite(trendNow)) return [];

  // Residuals.
  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    const residual = cleanCloses[i]! - (intercept + slope * i);
    if (finite(residual)) residuals.push(residual);
  }
  if (residuals.length === 0) return [];
  residuals.sort((a, b) => a - b);

  const empirical = (q: number): number => {
    const pos = q * (residuals.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    return residuals[lo]! * (1 - frac) + residuals[hi]! * frac;
  };

  return qs.map((q): QuantileBand => ({
    price: trendNow + empirical(q),
    quantile: q,
    band: q < 0.5 ? "lower" : "upper",
  })).filter((band) => finite(band.price));
}
