// Read-only adapter that calls the sealed THERMAL engine math primitives
// on a CALLER-SUPPLIED candle slice. This is the only way to do
// walk-forward without touching the live registry / cache.
//
// VALIDATION-ONLY. Calls only `kde`, `kdePeaks`, `validateLevel`,
// `computeAtr`, `buildPriceGrid`, `findPivots`, `marketProfile`,
// `recencyWeights`, `mergeIntoZones`, `garchVolatility`, `logReturns`
// — all pure, side-effect-free, read-only.
//
// LIVE TIER MODE: this adapter intentionally mirrors the EXACT live tier
// pipeline used by `services/orchestrator.computeLevelsData` →
// `services/levelRegistry/tierFromScore` so that the validation harness
// is grading the SAME 0/1/2/3 tier mapping the production engine emits.
// We DO NOT call the orchestrator (which has HL fetches, side effects
// and cache writes) — instead we replicate the pure-math zone build
// using the same primitives in the same order. The tier-from-score
// thresholds (0.4 / 0.65 / 0.85) are reproduced verbatim from the
// sealed `levelRegistry/index.ts` registry — see comment on
// `liveTierFromScore` below.

import {
  kde,
  kdePeaks,
  validateLevel,
  computeAtr,
  buildPriceGrid,
  findPivots,
  recencyWeights,
  marketProfile,
  type OhlcvBar,
} from "../engines/levels";
import { logReturns, garchVolatility } from "../engines/regime";
import { mergeIntoZones, type RawLevel } from "../engines/confluence";

export interface DiscoveredLevel {
  price: number;
  density: number;            // zone confluence score (live mode) or raw KDE density (proxy mode)
  tier: "elite" | "strong" | "normal";
  posteriorBounceRate: number;
  oosBounceRate: number;
  touches: number;
  detectionBarIndex: number;
}

export interface DetectionInputs {
  bars: OhlcvBar[];           // bars at indices [0..detectionIndex] OR a longer slice (anti-lookahead test)
  detectionIndex: number;     // cutoff time — adapter truncates to bars[0..detectionIndex]
  bins?: number;
  minSeparation?: number;
  topK?: number;
  // "live" (default) replicates the orchestrator → registry tier
  // pipeline (mergeIntoZones zone score → liveTierFromScore). "proxy"
  // is the legacy density-percentile heuristic, kept for diagnostics
  // only and clearly labelled in the report when used.
  tierMode?: "live" | "proxy";
}

const STALE_BARS = 200;

// REPRODUCES VERBATIM the sealed `tierFromScore` from
// `services/levelRegistry/index.ts`:
//
//     score >= 0.85  → tier 3 (elite)
//     score >= 0.65  → tier 2 (strong)
//     score >= 0.40  → tier 1 (normal)
//     else           → tier 0 (filtered out by registry MIN_STRENGTH)
//
// We replicate the constants here rather than import them because the
// sealed registry does not export them. Keeping the constants in sync is
// the single integration point with the live tier system; the
// `engineConfigHash` in `version.ts` covers the registry file so any
// drift in those thresholds will change the hash and invalidate the
// historical comparison.
function liveTierFromScore(score: number): "elite" | "strong" | "normal" | "filtered" {
  if (score >= 0.85) return "elite";
  if (score >= 0.65) return "strong";
  if (score >= 0.4) return "normal";
  return "filtered";
}

function finitePrices(values: number[]): number[] {
  return values.filter((x) => Number.isFinite(x) && x > 0);
}

export function discoverLevelsAt(inp: DetectionInputs): DiscoveredLevel[] {
  // Anti-lookahead boundary enforcement: regardless of how many bars the
  // caller hands us, every downstream computation here MUST see only
  // bars[0..detectionIndex]. This is the single chokepoint that lets the
  // anti-lookahead test work — pass bars[0..t+50] with detectionIndex=t
  // and the result MUST equal the baseline run on bars[0..t].
  const cutoff = Math.max(
    0,
    Math.min(inp.bars.length, inp.detectionIndex ?? inp.bars.length),
  );
  const bars = inp.bars.length === cutoff ? inp.bars : inp.bars.slice(0, cutoff);
  if (bars.length < 50) return [];

  const bins = inp.bins ?? 200;
  const minSep = inp.minSeparation ?? 6;
  const topK = inp.topK ?? 12;
  const mode = inp.tierMode ?? "live";

  const closes = finitePrices(bars.map((b) => b.close));
  if (closes.length < 30) return [];
  const currentPrice = closes[closes.length - 1]!;
  const lo = Math.min(...closes) * 0.995;
  const hi = Math.max(...closes) * 1.005;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];

  const grid = buildPriceGrid(lo, hi, bins);
  const atr = computeAtr(bars, 14);
  const tolerance = Math.max((hi - lo) * 0.003, atr * 0.25);
  const detIdx = bars.length;

  // Mirror the live orchestrator's KDE on swing pivots (NOT bar
  // mid-prices), recency-weighted, vol-scaled bandwidth — same primitives,
  // same arguments, same order. Equivalence with live behavior is what
  // makes the validation result transferable.
  const pivots = findPivots(bars, 3);
  const timeToIdx = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) timeToIdx.set(bars[i]!.time, i);
  const idxOf = (b: { time: number }): number => timeToIdx.get(b.time) ?? -1;
  const chrono: Array<{ idx: number; price: number }> = [
    ...pivots.highs.map((b) => ({ idx: idxOf(b), price: b.high })),
    ...pivots.lows.map((b) => ({ idx: idxOf(b), price: b.low })),
  ].sort((a, b) => a.idx - b.idx);
  const reversalPrices = chrono.map((p) => p.price);

  const returns = logReturns(closes);
  const vol = garchVolatility(returns);
  const volScale = 1 + Math.min(2, vol * 50);
  const pivotWeights = recencyWeights(reversalPrices.length, 1.5);
  const density = reversalPrices.length > 0
    ? kde(reversalPrices, grid, undefined, pivotWeights, volScale)
    : grid.map(() => 0);
  const peaks = kdePeaks(grid, density, minSep).slice(0, 12);
  if (peaks.length === 0) return [];

  // ---------------- Proxy mode (legacy diagnostic — clearly labelled) ----
  if (mode === "proxy") {
    const sortedDens = peaks.map((p) => p.density).slice().sort((a, b) => b - a);
    const eliteCut = sortedDens[Math.max(0, Math.floor(sortedDens.length * 0.1) - 1)] ?? Infinity;
    const strongCut = sortedDens[Math.max(0, Math.floor(sortedDens.length * 0.35) - 1)] ?? Infinity;
    const out: DiscoveredLevel[] = [];
    for (const p of peaks) {
      const v = validateLevel(bars, p.price, tolerance, 5, 2, {
        atr, oosFrac: 0.3, priorAlpha: 2, priorBeta: 2, detectionIndex: detIdx, staleBars: STALE_BARS,
      });
      let tier: "elite" | "strong" | "normal" = "normal";
      if (p.density >= eliteCut && v.posteriorBounceRate >= 0.55) tier = "elite";
      else if (p.density >= strongCut && v.posteriorBounceRate >= 0.5) tier = "strong";
      out.push({
        price: p.price, density: p.density, tier,
        posteriorBounceRate: v.posteriorBounceRate, oosBounceRate: v.oosBounceRate,
        touches: v.touches, detectionBarIndex: detIdx,
      });
    }
    out.sort((a, b) => b.density - a.density);
    return out.slice(0, topK);
  }

  // ---------------- Live mode (default — exact orchestrator pipeline) ----
  const baseOpts = { atr, staleBars: STALE_BARS, oosFrac: 0.3, priorAlpha: 2, priorBeta: 2 } as const;
  const raw: RawLevel[] = [];
  for (const pk of peaks) {
    raw.push({
      price: pk.price,
      method: "kde-pivot-cluster",
      kind: pk.price < currentPrice ? "support" : "resistance",
      strength: Math.min(1, pk.density * 100),
      validated: false, bounceRate: null, pValue: null, touches: null,
    });
  }
  const mp = marketProfile(bars.slice(-60));
  if (mp.poc) raw.push({ price: mp.poc, method: "market-profile-poc",
    kind: mp.poc < currentPrice ? "support" : "resistance", strength: 0.8,
    validated: false, bounceRate: null, pValue: null, touches: null });
  if (mp.valueAreaHigh) raw.push({ price: mp.valueAreaHigh, method: "value-area-high",
    kind: "resistance", strength: 0.5, validated: false, bounceRate: null, pValue: null, touches: null });
  if (mp.valueAreaLow) raw.push({ price: mp.valueAreaLow, method: "value-area-low",
    kind: "support", strength: 0.5, validated: false, bounceRate: null, pValue: null, touches: null });
  for (const h of pivots.highs.slice(-10)) raw.push({ price: h.high, method: "swing-pivot",
    kind: "resistance", strength: 0.4, validated: false, bounceRate: null, pValue: null, touches: null });
  for (const l of pivots.lows.slice(-10)) raw.push({ price: l.low, method: "swing-pivot",
    kind: "support", strength: 0.4, validated: false, bounceRate: null, pValue: null, touches: null });

  // Validate each raw level using the same gate the live engine applies
  // (the gateLight variant: touches >= 2, posteriorBounceRate >= 0.6,
  // bounceRate >= 0.6, p < 0.15, not stale).
  for (const r of raw) {
    const v = validateLevel(bars, r.price, tolerance, 5, 2, { ...baseOpts, detectionIndex: detIdx });
    r.bounceRate = v.touches > 0 ? v.posteriorBounceRate : null;
    r.pValue = v.touches > 0 ? v.pValue : null;
    r.touches = v.touches;
    r.validated = v.touches >= 2 && v.posteriorBounceRate >= 0.6
      && v.bounceRate >= 0.6 && v.pValue < 0.15 && !v.isStale;
  }

  const proximityPct = Math.max(0.002, Math.min(0.008, vol * 2));
  const zones = mergeIntoZones(raw, proximityPct);

  const out: DiscoveredLevel[] = [];
  for (const z of zones) {
    const tier = liveTierFromScore(z.score);
    if (tier === "filtered") continue;  // registry would have evicted this (MIN_STRENGTH)
    const mid = (z.priceLow + z.priceHigh) / 2;
    const zoneTol = Math.max(tolerance, (z.priceHigh - z.priceLow) / 2);
    const v = validateLevel(bars, mid, zoneTol, 5, 2, { ...baseOpts, detectionIndex: detIdx });
    out.push({
      price: mid,
      density: z.score,
      tier,
      posteriorBounceRate: v.posteriorBounceRate,
      oosBounceRate: v.oosBounceRate,
      touches: v.touches,
      detectionBarIndex: detIdx,
    });
  }
  out.sort((a, b) => b.density - a.density);
  return out.slice(0, topK);
}

// Re-exported pure helpers so other validation modules (benchmarks,
// evaluator) can use the same primitives without re-importing across
// the engine boundary themselves.
export { computeAtr, findPivots };
export type { OhlcvBar };

// Exposed for unit tests so the test can verify the exact thresholds
// match the sealed `tierFromScore`. Internal otherwise.
export const __liveTierFromScore = liveTierFromScore;
