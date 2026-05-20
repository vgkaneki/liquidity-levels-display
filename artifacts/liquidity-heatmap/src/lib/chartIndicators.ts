export function computeSMA(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= length) sum -= closes[i - length]!;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

export function computeEMA(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0 || values.length < length) return out;
  const k = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i]!;
  let ema = sum / length;
  out[length - 1] = ema;
  for (let i = length; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function computeBollingerBands(
  closes: number[],
  length: number,
  mult: number,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = computeSMA(closes, length);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = length - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const diff = closes[j]! - mid[i]!;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / length);
    upper[i] = mid[i]! + mult * std;
    lower[i] = mid[i]! - mult * std;
  }
  return { mid, upper, lower };
}
