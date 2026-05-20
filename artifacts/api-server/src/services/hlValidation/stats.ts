// Wilson 95% CI + sample-size labelling.
// VALIDATION-ONLY.

import type { ProportionStat, SampleLabel } from "./types";

const Z = 1.959963984540054;  // 95%

export function wilson(k: number, n: number): { p: number; low95: number; high95: number } {
  if (n <= 0) return { p: 0, low95: 0, high95: 0 };
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { p, low95: Math.max(0, center - margin), high95: Math.min(1, center + margin) };
}

export function sampleLabel(n: number): SampleLabel {
  if (n < 30) return "very-low";
  if (n < 100) return "low";
  if (n < 300) return "moderate";
  return "headline";
}

export function proportion(k: number, n: number): ProportionStat {
  const w = wilson(k, n);
  return { k, n, p: w.p, low95: w.low95, high95: w.high95, label: sampleLabel(n) };
}

export function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "—";
}

export function fmtR(x: number): string {
  return Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(3)}R` : "—";
}

export function expectancyR(rMultiples: number[]): number {
  if (rMultiples.length === 0) return 0;
  let s = 0;
  for (const r of rMultiples) s += r;
  return s / rMultiples.length;
}

export function lowSampleWarning(n: number): string | null {
  if (n < 30) return "VERY LOW SAMPLE — interpret as exploratory only.";
  if (n < 100) return "LOW CONFIDENCE — wide CI; not headline-eligible.";
  if (n < 300) return "MODERATE CONFIDENCE — directional but not headline-eligible.";
  return null;
}
