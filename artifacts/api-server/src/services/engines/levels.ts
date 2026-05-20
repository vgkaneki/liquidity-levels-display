/**
 * Statistical level engines.
 *
 * Provides: KDE of historical reversal points, Market Profile (TPO/Volume
 * Profile), pivot detection, swing high/low extraction, and level validation
 * (touch counting, decay-weighted bounce rate, Bayesian posterior, walk-forward
 * OOS split, staleness detection).
 *
 * All public functions are pure and side-effect free. Every numeric input is
 * validated with `finite()` before use; no function throws on bad input.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LevelValidation {
  touches: number;
  bounceRate: number;
  pValue: number;
  /** Touches that occurred in the most recent `oosFrac` portion of the series. */
  oosTouches: number;
  oosBounceRate: number;
  /**
   * Bayesian-shrunk bounce rate using a Beta(α, β) prior (default α=β=2).
   * Pulls low-touch counts toward 0.5, preventing 1-of-1 from scoring as
   * confidently as 10-of-10.
   */
  posteriorBounceRate: number;
}

// ---------------------------------------------------------------------------
// Internal constants & guards
// ---------------------------------------------------------------------------

/** Minimum positive denominator — prevents division-by-zero in KDE. */
const EPS = 1e-12;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Clamps `n` to a positive integer ≥ `min`. Returns `fallback` when `n` is
 * not a finite number.
 */
function safePositiveInt(n: number, fallback: number, min = 1): number {
  return finite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

function isValidBar(b: OhlcvBar | undefined): b is OhlcvBar {
  return (
    b != null &&
    finite(b.time) &&
    finite(b.open) &&
    finite(b.high) &&
    finite(b.low) &&
    finite(b.close) &&
    finite(b.volume) &&
    b.high >= b.low
  );
}

function cleanBars(bars: OhlcvBar[]): OhlcvBar[] {
  return bars.filter(isValidBar);
}

// ---------------------------------------------------------------------------
// Pivot detection
// ---------------------------------------------------------------------------

/**
 * Detect swing highs and lows using a symmetric fractal of `k` bars on each
 * side. A bar is a swing high if its `high` strictly exceeds all `k` neighbors
 * on both sides; symmetric for swing lows.
 */
export function findPivots(
  bars: OhlcvBar[],
  k = 3,
): { highs: OhlcvBar[]; lows: OhlcvBar[] } {
  const clean = cleanBars(bars);
  const span = safePositiveInt(k, 3, 1);
  const highs: OhlcvBar[] = [];
  const lows: OhlcvBar[] = [];

  if (clean.length < span * 2 + 1) return { highs, lows };

  for (let i = span; i < clean.length - span; i++) {
    const b = clean[i]!;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= span; j++) {
      const left = clean[i - j]!;
      const right = clean[i + j]!;
      if (left.high >= b.high || right.high >= b.high) isHigh = false;
      if (left.low <= b.low || right.low <= b.low) isLow = false;
      // Short-circuit once both flags are false.
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push(b);
    if (isLow) lows.push(b);
  }

  return { highs, lows };
}

// ---------------------------------------------------------------------------
// Gaussian KDE
// ---------------------------------------------------------------------------

/**
 * Gaussian kernel density estimate evaluated on `grid`.
 *
 * - Optional per-sample `weights` (must match `prices` length; falls back to
 *   uniform weight 1 when absent or mismatched).
 * - `volScale` multiplies Silverman's rule-of-thumb bandwidth so noisier
 *   regimes get smoother density (fewer spurious peaks) and quiet regimes
 *   get tighter resolution. Clamped to [0.5, ∞).
 * - Returns all-zeros when there are no valid samples or the grid is empty.
 */
export function kde(
  prices: number[],
  grid: number[],
  bandwidth?: number,
  weights?: number[],
  volScale = 1,
): number[] {
  // Collect valid (price, weight) pairs.
  const samples: Array<{ price: number; weight: number }> = [];
  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    const rawWeight =
      weights && weights.length === prices.length ? weights[i] : 1;
    if (!finite(price) || !finite(rawWeight) || rawWeight! <= 0) continue;
    samples.push({ price: price!, weight: rawWeight! });
  }

  const outZeros = (): number[] => grid.map(() => 0);
  if (samples.length === 0 || grid.length === 0) return outZeros();

  const wSum = samples.reduce((s, x) => s + x.weight, 0);
  if (!finite(wSum) || wSum <= 0) return outZeros();

  // Weighted mean and variance for Silverman's bandwidth.
  const mean = samples.reduce((s, x) => s + x.price * x.weight, 0) / wSum;
  const variance =
    samples.reduce((s, x) => s + x.weight * (x.price - mean) ** 2, 0) / wSum;
  const sigma = Math.sqrt(Math.max(variance, 0)) || 1;
  const n = samples.length;

  // Bandwidth: caller override → Silverman's rule, then apply volScale.
  const rawBw = bandwidth ?? 1.06 * sigma * Math.pow(n, -0.2);
  const scale = finite(volScale) ? Math.max(0.5, volScale) : 1;
  const h = Math.max(
    EPS,
    (finite(rawBw) && rawBw > 0 ? rawBw : sigma) * scale,
  );

  const norm = 1 / (wSum * h * Math.sqrt(2 * Math.PI));

  return grid.map((g) => {
    if (!finite(g)) return 0;
    let s = 0;
    for (const { price, weight } of samples) {
      const u = (g - price) / h;
      s += weight * Math.exp(-0.5 * u * u);
    }
    const density = s * norm;
    return finite(density) && density >= 0 ? density : 0;
  });
}

// ---------------------------------------------------------------------------
// Recency weights
// ---------------------------------------------------------------------------

/**
 * Exponential recency weights for an ordered series of `n` samples
 * (oldest = index 0, newest = index n-1).
 *
 * weight[i] = exp(-λ · (1 - (i+1)/n))
 *
 * Newest sample → weight 1; oldest → exp(-λ). Default λ=1.5 gives the
 * oldest sample ~22% of the newest sample's weight.
 */
export function recencyWeights(n: number, lambda = 1.5): number[] {
  const count = finite(n) ? Math.floor(n) : 0;
  if (count <= 0) return [];
  const decay = finite(lambda) ? Math.max(0, lambda) : 1.5;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.exp(-decay * (1 - (i + 1) / count)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------

/**
 * Average True Range over the last `period` bars (arithmetic mean, not Wilder
 * smoothing). Suitable for level tolerance calculations.
 * Returns 0 when there are fewer than 2 valid bars.
 */
export function computeAtr(bars: OhlcvBar[], period = 14): number {
  const clean = cleanBars(bars);
  if (clean.length < 2) return 0;

  const safePeriod = safePositiveInt(period, 14, 1);
  const trs: number[] = [];

  for (let i = 1; i < clean.length; i++) {
    const b = clean[i]!;
    const p = clean[i - 1]!;
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - p.close),
      Math.abs(b.low - p.close),
    );
    if (finite(tr) && tr >= 0) trs.push(tr);
  }

  const tail = trs.slice(-safePeriod);
  return tail.length > 0
    ? tail.reduce((s, x) => s + x, 0) / tail.length
    : 0;
}

// ---------------------------------------------------------------------------
// Price grid
// ---------------------------------------------------------------------------

/**
 * Build an evenly-spaced price grid of `bins + 1` points spanning [min, max].
 * Swaps min/max if inverted. Returns an all-`min` array when min === max
 * (degenerate range). Returns [] when min or max is non-finite.
 */
export function buildPriceGrid(
  min: number,
  max: number,
  bins = 200,
): number[] {
  if (!finite(min) || !finite(max)) return [];
  const safeBins = safePositiveInt(bins, 200, 1);
  if (max < min) [min, max] = [max, min];
  if (max === min) return Array.from({ length: safeBins + 1 }, () => min);

  const step = (max - min) / safeBins;
  const out: number[] = [];
  for (let i = 0; i <= safeBins; i++) out.push(min + step * i);
  return out;
}

// ---------------------------------------------------------------------------
// KDE peaks
// ---------------------------------------------------------------------------

/**
 * Find local maxima of a KDE density array, enforce a minimum grid-index
 * separation between kept peaks, and return them sorted by descending density.
 *
 * `minSeparation` is in grid-index units (not price units), so a separation
 * of 5 on a 200-bin grid means peaks must be at least 5/200 = 2.5% of the
 * price range apart.
 */
export function kdePeaks(
  grid: number[],
  density: number[],
  minSeparation = 5,
): Array<{ price: number; density: number }> {
  const n = Math.min(grid.length, density.length);
  if (n < 3) return [];

  const sep = safePositiveInt(minSeparation, 5, 1);
  const candidates: Array<{ price: number; density: number; idx: number }> = [];

  for (let i = 1; i < n - 1; i++) {
    const price = grid[i];
    const d = density[i];
    const left = density[i - 1];
    const right = density[i + 1];
    if (!finite(price) || !finite(d) || !finite(left) || !finite(right)) continue;
    if (d! > left! && d! > right!) {
      candidates.push({ price: price!, density: d!, idx: i });
    }
  }

  // Sort by density descending, then greedily keep well-separated peaks.
  candidates.sort((a, b) => b.density - a.density);

  const kept: Array<{ price: number; density: number }> = [];
  const usedIdx: number[] = [];

  for (const p of candidates) {
    if (usedIdx.every((u) => Math.abs(u - p.idx) >= sep)) {
      kept.push({ price: p.price, density: p.density });
      usedIdx.push(p.idx);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Market Profile (TPO)
// ---------------------------------------------------------------------------

/**
 * Time-at-Price market profile. Each bar contributes 1 unit for every price
 * bucket its [low, high] range spans.
 *
 * Returns:
 * - `bins`: time-at-price histogram
 * - `poc`: Point of Control (highest-TPO bin mid-price)
 * - `valueAreaHigh` / `valueAreaLow`: bounds of the 70% value area around POC
 */
export function marketProfile(
  bars: OhlcvBar[],
  bins = 80,
): {
  bins: Array<{ price: number; timeAtPrice: number }>;
  poc: number;
  valueAreaHigh: number;
  valueAreaLow: number;
} {
  const empty = { bins: [], poc: 0, valueAreaHigh: 0, valueAreaLow: 0 };
  const clean = cleanBars(bars);
  const safeBins = safePositiveInt(bins, 80, 1);

  if (clean.length === 0) return empty;

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of clean) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  if (!finite(lo) || !finite(hi) || hi <= lo) return empty;

  const step = (hi - lo) / safeBins;
  if (!finite(step) || step <= 0) return empty;

  const counts = new Array<number>(safeBins).fill(0);
  for (const b of clean) {
    const lowIdx = Math.max(0, Math.min(safeBins - 1, Math.floor((b.low - lo) / step)));
    const highIdx = Math.max(0, Math.min(safeBins - 1, Math.floor((b.high - lo) / step)));
    for (let i = lowIdx; i <= highIdx; i++) counts[i] = (counts[i] ?? 0) + 1;
  }

  const out = counts.map((c, i) => ({
    price: lo + step * (i + 0.5),
    timeAtPrice: c,
  }));

  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 0) return { bins: out, poc: 0, valueAreaHigh: 0, valueAreaLow: 0 };

  // Point of Control: bin with highest time-at-price.
  let pocIdx = 0;
  for (let i = 1; i < counts.length; i++) {
    if ((counts[i] ?? 0) > (counts[pocIdx] ?? 0)) pocIdx = i;
  }

  // Value Area: expand outward from POC until 70% of total TPO is captured.
  // At each step expand whichever side has the higher adjacent count (ties
  // favor the upper side to break symmetry consistently).
  const target = total * 0.7;
  let acc = counts[pocIdx] ?? 0;
  let lowI = pocIdx;
  let highI = pocIdx;

  while (acc < target && (lowI > 0 || highI < counts.length - 1)) {
    const leftCount = lowI > 0 ? (counts[lowI - 1] ?? 0) : -1;
    const rightCount = highI < counts.length - 1 ? (counts[highI + 1] ?? 0) : -1;
    if (rightCount >= leftCount) {
      highI++;
      acc += counts[highI] ?? 0;
    } else {
      lowI--;
      acc += counts[lowI] ?? 0;
    }
  }

  return {
    bins: out,
    poc: lo + step * (pocIdx + 0.5),
    valueAreaHigh: lo + step * (highI + 1),
    valueAreaLow: lo + step * lowI,
  };
}

// ---------------------------------------------------------------------------
// Level validation
// ---------------------------------------------------------------------------

/**
 * Validate a price level by scanning for touch events and computing:
 *
 * - `touches`: raw count of bars that touched the ±tolerance band
 * - `bounceRate`: exponentially decay-weighted fraction of touches that
 *   resulted in a meaningful move (recent touches matter more)
 * - `pValue`: one-sided binomial p-value vs. null hypothesis p₀=0.5
 * - `oosTouches` / `oosBounceRate`: walk-forward out-of-sample stats
 * - `posteriorBounceRate`: Bayesian shrinkage toward Beta(α,β) prior mean
 * - `lastTouchAge`: bars since the most recent touch (Infinity if no touches)
 * - `isStale`: true when lastTouchAge exceeds `staleBars`
 *
 * A "bounce" requires the price to move more than max(2·tolerance, 0.75·ATR)
 * within `lookahead` bars of the touch. ATR normalization keeps the threshold
 * consistent across volatility regimes.
 */
export function validateLevel(
  bars: OhlcvBar[],
  price: number,
  tolerance: number,
  lookahead = 5,
  decayLambda = 2,
  opts?: {
    atr?: number;
    oosFrac?: number;
    priorAlpha?: number;
    priorBeta?: number;
    detectionIndex?: number;
    staleBars?: number;
  },
): LevelValidation & { lastTouchAge: number; isStale: boolean } {
  // Resolve Bayesian prior parameters (must be > 0).
  const priorAlpha =
    finite(opts?.priorAlpha) && opts!.priorAlpha! > 0 ? opts!.priorAlpha! : 2;
  const priorBeta =
    finite(opts?.priorBeta) && opts!.priorBeta! > 0 ? opts!.priorBeta! : 2;

  const empty = (): LevelValidation & { lastTouchAge: number; isStale: boolean } => ({
    touches: 0,
    bounceRate: 0,
    pValue: 1,
    oosTouches: 0,
    oosBounceRate: 0,
    posteriorBounceRate: priorAlpha / (priorAlpha + priorBeta),
    lastTouchAge: Infinity,
    isStale: true,
  });

  const clean = cleanBars(bars);
  if (clean.length === 0 || !finite(price)) return empty();

  const tol = finite(tolerance) ? Math.max(0, Math.abs(tolerance)) : 0;
  const atr = finite(opts?.atr) ? Math.max(0, opts!.atr!) : 0;
  const oosFrac = finite(opts?.oosFrac)
    ? Math.min(1, Math.max(0, opts!.oosFrac!))
    : 0.3;

  // Walk-forward split: bar index at or after which touches are out-of-sample.
  const rawDetectionIndex = finite(opts?.detectionIndex)
    ? Math.floor(opts!.detectionIndex!)
    : Math.floor(clean.length * (1 - oosFrac));
  const detectionIndex = Math.max(0, Math.min(clean.length, rawDetectionIndex));

  const staleBars = finite(opts?.staleBars)
    ? Math.max(0, Math.floor(opts!.staleBars!))
    : 200;
  const ahead = safePositiveInt(lookahead, 5, 1);
  const decay = finite(decayLambda) ? Math.max(0, decayLambda) : 2;

  // Minimum bounce magnitude: max of 2·tolerance and 0.75·ATR.
  // ATR term ensures the bounce threshold scales with market volatility.
  const minMove = Math.max(tol * 2, atr * 0.75);

  // Detect touch events.
  const touchEvents: Array<{ idx: number; bounced: boolean }> = [];
  for (let i = 0; i < clean.length - ahead; i++) {
    const b = clean[i]!;
    // Touch: the bar's range overlaps the ±tolerance band around `price`.
    if (b.low <= price + tol && b.high >= price - tol) {
      const refClose = b.close;
      let bounced = false;
      for (
        let j = i + 1;
        j <= Math.min(clean.length - 1, i + ahead);
        j++
      ) {
        if (Math.abs(clean[j]!.close - refClose) > minMove) {
          bounced = true;
          break;
        }
      }
      touchEvents.push({ idx: i, bounced });
    }
  }

  const n = touchEvents.length;
  if (n === 0) return empty();

  // Staleness.
  const lastTouchIdx = touchEvents[n - 1]!.idx;
  const lastTouchAge = clean.length - 1 - lastTouchIdx;
  const isStale = lastTouchAge > staleBars;

  // Decay-weighted bounce rate: recent touches carry exponentially higher weight.
  let wSum = 0;
  let wBounces = 0;
  for (let j = 0; j < n; j++) {
    const w = Math.exp(-decay * (1 - (j + 1) / n));
    wSum += w;
    if (touchEvents[j]!.bounced) wBounces += w;
  }
  const bounceRate = wSum > 0 ? wBounces / wSum : 0;

  // Walk-forward OOS stats.
  const oosEvents = touchEvents.filter((t) => t.idx >= detectionIndex);
  const oosTouches = oosEvents.length;
  const oosBounceRate = oosTouches
    ? oosEvents.filter((t) => t.bounced).length / oosTouches
    : 0;

  // One-sided binomial p-value (raw unweighted counts) vs. p₀ = 0.5.
  const k = touchEvents.filter((t) => t.bounced).length;
  const pValue = n >= 3 ? binomUpperTailHalf(n, k) : 1;

  // Bayesian posterior: Beta(priorAlpha + k, priorBeta + n - k) mean.
  const posteriorBounceRate = (priorAlpha + k) / (priorAlpha + priorBeta + n);

  return {
    touches: n,
    bounceRate,
    pValue,
    oosTouches,
    oosBounceRate,
    posteriorBounceRate,
    lastTouchAge,
    isStale,
  };
}

// ---------------------------------------------------------------------------
// Binomial statistics (internal)
// ---------------------------------------------------------------------------

/**
 * Log of C(n, k) using the numerically stable additive form.
 * Returns -Infinity for out-of-range k.
 */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  const m = Math.min(k, n - k);
  let out = 0;
  for (let i = 1; i <= m; i++) {
    out += Math.log(n - m + i) - Math.log(i);
  }
  return out;
}

/**
 * One-sided upper-tail binomial probability P(X ≥ k | n, p=0.5).
 * Used to test whether bounce rate is significantly above chance.
 *
 * Computed iteratively to avoid materialising all C(n,i) at once.
 * Returns 1 when k ≤ 0 (trivially true), 0 when k > n (impossible).
 */
function binomUpperTailHalf(n: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;

  // P(X = k) = C(n,k) · (0.5)^n
  const logP0 = logChoose(n, k) - n * Math.log(2);
  let p = Math.exp(logP0);
  let sum = p;

  // Accumulate P(X = k+1), P(X = k+2), ... using the recurrence
  // P(X = i+1) = P(X = i) · (n-i) / (i+1)
  for (let i = k; i < n; i++) {
    p *= (n - i) / (i + 1);
    if (!finite(p) || p <= 0) break;
    sum += p;
    if (sum >= 1) return 1;
  }

  return finite(sum) ? Math.min(1, Math.max(0, sum)) : 1;
}
