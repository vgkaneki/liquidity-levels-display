// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This module is a DISPLAY-ONLY diagnostic that compares live DOM
// liquidity against the registry's structural / liquidity levels and
// reports alignment metrics. It is NOT, and must NEVER become, part of:
//   • level discovery, ranking, persistence, or decay
// • scoring, pivots, quantile bands, confluence, presets
//   • backtest reliability or any overlay logic that influences which
//     levels exist or how strong they are
//
// All inputs are taken from the engine's PUBLIC OUTPUTS (the same
// data the chart already renders). The output is purely descriptive.
// Do NOT use the values produced here to mutate the registry, retrain
// scoring, or feed any engine input. If a future feature wants to use
// DOM data to *generate* levels, it must be a separate engine module
// with its own audited path, not this diagnostic.
// =====================================================================
//
// Pure functions only — no React, no I/O, no side effects. The hook
// (`useDomAlignment.ts`) is the only React glue. Splitting this way
// keeps the matching algorithm fully unit-testable from node:test
// (see src/__tests__/domAlignment.test.mjs).

import type { RegistryLevel } from "@/hooks/useRegistryLevels";

export interface HeatLevelLike {
  price: number;
  bidSize: number;
  askSize: number;
}

export interface DomWall {
  price: number;
  bidSize: number;
  askSize: number;
  size: number;            // max(bid, ask) — the "wall" magnitude
  totalSize: number;       // bid + ask
  dominantSide: "bid" | "ask";
  sizeRank: number;        // 1-based, 1 = biggest in selected set
}

export type MatchQuality = "tight" | "near" | "loose" | "none";
export type SideAgreement = "agree" | "disagree" | "n/a";
export type Confidence = "high" | "med" | "low" | "none";

export interface AlignmentRecord {
  wall: DomWall;
  nearestLevel: RegistryLevel | null;
  distance: {
    price: number;       // absolute price distance
    ticks: number;       // distance / tickSize
    percent: number;     // distance / mark * 100
  } | null;
  matchQuality: MatchQuality;
  sideAgreement: SideAgreement;
  confidence: Confidence;
}

export interface AlignmentSummary {
  domWallCount: number;
  matchedDomWalls: number;        // tight + near
  domCoverageRate: number;        // matchedDomWalls / domWallCount, 0..1
  registryLevelsInRange: number;
  registryWithDomSupport: number; // levels that have a top-N DOM wall within near band
  registrySupportRate: number;    // 0..1
  sideAgreeCount: number;
  sideAgreeTotal: number;         // among matched only
  sideAgreeRate: number;          // 0..1
  tickSize: number;
  markPrice: number | null;
}

export interface AlignmentOptions {
  /** How many top DOM walls to track (by max(bid,ask) size). Default 12. */
  topN?: number;
  /** Tight match threshold in % of mark. Default 0.05 (= 5 bps). */
  tightPct?: number;
  /** Near match threshold in % of mark. Default 0.15 (= 15 bps). */
  nearPct?: number;
  /** Loose match threshold in % of mark. Default 0.50 (= 50 bps). */
  loosePct?: number;
  /** Visible price-range filter for "registry levels in range" denominator.
   * Default 5%, matching the typical L2 + structural visible window. */
  rangePct?: number;
}

const DEFAULT_OPTS: Required<AlignmentOptions> = {
  topN: 12,
  tightPct: 0.05,
  nearPct: 0.15,
  loosePct: 0.50,
  rangePct: 5.0,
};

/**
 * Derive the effective tick size for the symbol from the live depth
 * array — the smallest non-zero gap between consecutive prices is the
 * exchange's quoting increment. Falls back to 10^-priceDecimals when
 * the depth array is too sparse to derive (e.g. cold start).
 *
 * Why not just use priceDecimals? On many futures venues the quoting
 * increment is coarser than the display precision (BTC futures often
 * tick at $0.10 even though the chart shows two decimals). Deriving
 * from the actual depth gives the correct units for "distance in
 * ticks" — which is what the user asked for.
 */
export function deriveTickSize(
  levels: ReadonlyArray<HeatLevelLike>,
  priceDecimals: number,
): number {
  const fallback = Math.pow(10, -Math.max(0, Math.min(12, priceDecimals)));
  if (!levels || levels.length < 2) return fallback;
  // Copy + sort so we don't mutate caller's array; bounded N (typically
  // <200) so this is fine at frame rate.
  const prices: number[] = [];
  for (const lv of levels) {
    if (Number.isFinite(lv.price) && lv.price > 0) prices.push(lv.price);
  }
  if (prices.length < 2) return fallback;
  prices.sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const gap = prices[i]! - prices[i - 1]!;
    if (gap > 1e-12 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap) || minGap <= 0) return fallback;
  // Guard against pathologically tiny gaps (sub-cent dust on a $77k
  // contract) by clamping to the fallback floor.
  return Math.max(minGap, fallback);
}

/**
 * Pick the top-N "walls" from the depth array by size. We rank by
 * max(bidSize, askSize) — a single huge bid is a wall even if the
 * matching ask is tiny, and vice-versa — and break ties by total size.
 * Each returned wall carries its dominant side so we can decide
 * support-vs-resistance agreement downstream.
 */
export function selectTopDomWalls(
  levels: ReadonlyArray<HeatLevelLike>,
  topN: number,
): DomWall[] {
  if (!levels || levels.length === 0 || topN <= 0) return [];
  const out: DomWall[] = [];
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const bid = Number.isFinite(lv.bidSize) ? Math.max(0, lv.bidSize) : 0;
    const ask = Number.isFinite(lv.askSize) ? Math.max(0, lv.askSize) : 0;
    const size = Math.max(bid, ask);
    const totalSize = bid + ask;
    if (size <= 0 && totalSize <= 0) continue;
    out.push({
      price: lv.price,
      bidSize: bid,
      askSize: ask,
      size,
      totalSize,
      dominantSide: bid >= ask ? "bid" : "ask",
      sizeRank: 0, // assigned after sort
    });
  }
  out.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.totalSize - a.totalSize;
  });
  const trimmed = out.slice(0, topN);
  for (let i = 0; i < trimmed.length; i++) trimmed[i]!.sizeRank = i + 1;
  return trimmed;
}

/** Find the registry level whose price is closest to `price`. */
export function findNearestLevel(
  price: number,
  registry: ReadonlyArray<RegistryLevel>,
): RegistryLevel | null {
  if (!Number.isFinite(price) || !registry || registry.length === 0) return null;
  let best: RegistryLevel | null = null;
  let bestAbs = Infinity;
  for (const lv of registry) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const d = Math.abs(lv.price - price);
    if (d < bestAbs) {
      bestAbs = d;
      best = lv;
    }
  }
  return best;
}

export function classifyDistance(
  distancePct: number,
  opts: Required<AlignmentOptions>,
): MatchQuality {
  if (!Number.isFinite(distancePct)) return "none";
  if (distancePct <= opts.tightPct) return "tight";
  if (distancePct <= opts.nearPct) return "near";
  if (distancePct <= opts.loosePct) return "loose";
  return "none";
}

export function classifySide(
  wall: DomWall,
  level: RegistryLevel | null,
): SideAgreement {
  if (!level) return "n/a";
  // Bids represent buy interest below price → support; asks represent
  // sell interest above price → resistance. A bid wall coinciding with
  // a support level is the engine and the order book agreeing about
  // where the floor is. Mirror for ask walls and resistance levels.
  const wallSide = wall.dominantSide === "bid" ? "support" : "resistance";
  return wallSide === level.side ? "agree" : "disagree";
}

export function classifyConfidence(
  quality: MatchQuality,
  sizeRank: number,
): Confidence {
  if (quality === "none") return "none";
  // Top-3 walls with a tight match are high-confidence diagnostic
  // anchors. Top-3 with a near match, or any tight match outside top-3,
  // is medium. Loose is always low.
  if (quality === "tight" && sizeRank <= 3) return "high";
  if (quality === "tight") return "med";
  if (quality === "near" && sizeRank <= 3) return "med";
  if (quality === "near") return "low";
  return "low"; // loose
}

/**
 * Core algorithm: take the live DOM depth + the registry levels +
 * the live mark price + the tick size, and produce one record per
 * top-N wall describing how well it aligns with our levels.
 */
export function computeAlignment(
  depth: ReadonlyArray<HeatLevelLike>,
  registry: ReadonlyArray<RegistryLevel>,
  markPrice: number | null,
  tickSize: number,
  options: AlignmentOptions = {},
): AlignmentRecord[] {
  const opts: Required<AlignmentOptions> = { ...DEFAULT_OPTS, ...options };
  const walls = selectTopDomWalls(depth, opts.topN);
  if (walls.length === 0) return [];
  const out: AlignmentRecord[] = [];
  for (const wall of walls) {
    const nearest = findNearestLevel(wall.price, registry);
    let distance: AlignmentRecord["distance"] = null;
    let quality: MatchQuality = "none";
    if (nearest) {
      const priceDiff = Math.abs(nearest.price - wall.price);
      const ticks = tickSize > 0 ? priceDiff / tickSize : 0;
      const percent =
        markPrice && markPrice > 0 ? (priceDiff / markPrice) * 100 : Infinity;
      distance = { price: priceDiff, ticks, percent };
      quality = classifyDistance(percent, opts);
    }
    const sideAgreement = classifySide(wall, quality === "none" ? null : nearest);
    const confidence = classifyConfidence(quality, wall.sizeRank);
    out.push({
      wall,
      nearestLevel: nearest,
      distance,
      matchQuality: quality,
      sideAgreement,
      confidence,
    });
  }
  return out;
}

/**
 * Aggregate hit-rate metrics: of the top-N DOM walls, how many landed
 * inside our nearest registry level? Of the registry levels in the
 * visible price range, how many had a top-N DOM wall sitting on them?
 * Of the matched pairs, how often did the engine's side classification
 * agree with the order-book's dominant side?
 */
export function summarize(
  records: ReadonlyArray<AlignmentRecord>,
  registry: ReadonlyArray<RegistryLevel>,
  markPrice: number | null,
  tickSize: number,
  options: AlignmentOptions = {},
): AlignmentSummary {
  const opts: Required<AlignmentOptions> = { ...DEFAULT_OPTS, ...options };

  const matchedRecs = records.filter(
    (r) => r.matchQuality === "tight" || r.matchQuality === "near",
  );
  const matchedDomWalls = matchedRecs.length;

  // Registry-side metric: only count levels actually in the visible
  // window (within ±rangePct of mark). A level 50% away from price
  // having "no DOM support" is meaningless — there is no live DOM
  // anywhere near it because the L2 stream only carries depth in a
  // small band around the inside book.
  const inRange: RegistryLevel[] = [];
  if (markPrice && markPrice > 0) {
    const halfBand = (markPrice * opts.rangePct) / 100;
    for (const lv of registry) {
      if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
      if (Math.abs(lv.price - markPrice) <= halfBand) inRange.push(lv);
    }
  }

  let registryWithDomSupport = 0;
  if (inRange.length > 0 && records.length > 0) {
    const nearTol = markPrice ? (markPrice * opts.nearPct) / 100 : 0;
    for (const lv of inRange) {
      let supported = false;
      for (const r of records) {
        if (Math.abs(r.wall.price - lv.price) <= nearTol) {
          supported = true;
          break;
        }
      }
      if (supported) registryWithDomSupport++;
    }
  }

  let sideAgreeCount = 0;
  let sideAgreeTotal = 0;
  for (const r of matchedRecs) {
    if (r.sideAgreement === "agree") {
      sideAgreeCount++;
      sideAgreeTotal++;
    } else if (r.sideAgreement === "disagree") {
      sideAgreeTotal++;
    }
  }

  const domCoverageRate =
    records.length > 0 ? matchedDomWalls / records.length : 0;
  const registrySupportRate =
    inRange.length > 0 ? registryWithDomSupport / inRange.length : 0;
  const sideAgreeRate =
    sideAgreeTotal > 0 ? sideAgreeCount / sideAgreeTotal : 0;

  return {
    domWallCount: records.length,
    matchedDomWalls,
    domCoverageRate,
    registryLevelsInRange: inRange.length,
    registryWithDomSupport,
    registrySupportRate,
    sideAgreeCount,
    sideAgreeTotal,
    sideAgreeRate,
    tickSize,
    markPrice,
  };
}
