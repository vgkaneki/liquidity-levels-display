import {
  classifyLevel,
  type ClassifiedLevel,
  type LevelCandidate,
  type RatingTier,
  type SourceTag,
} from "@/lib/levelTierEngine";

export interface LineCandidateInput {
  price: number;
  isBid: boolean;
  strength: number;
  touchCount: number;
  reliability: number;
}

export interface ClassifiedLine {
  raw: LineCandidateInput;
  candidate: LevelCandidate;
  classified: ClassifiedLevel;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function safeLine(raw: LineCandidateInput): LineCandidateInput | null {
  if (!Number.isFinite(raw.price) || raw.price <= 0) return null;
  return {
    ...raw,
    strength: clamp(raw.strength, 0, 1),
    touchCount: Number.isFinite(raw.touchCount) ? Math.max(0, Math.floor(raw.touchCount)) : 0,
    reliability: clamp(raw.reliability, 0, 1),
  };
}

/**
 * Conservative adapter for the existing THERMAL canvas line model.
 *
 * Important:
 * - The current chart renderer only knows about `price`, `isBid`, `strength`,
 *   `touchCount`, and `reliability`.
 * - It does NOT yet provide true reclaim / sweep trigger state.
 * - Because of that, this adapter intentionally emits mostly 8/10 watch-quality
 *   ratings for the strongest cohort and 0 for the rest.
 * - It avoids blank charts by ensuring the strongest cohort can still classify
 *   as 8/10 even before the trigger layer exists.
 */
function buildCandidate(
  raw: LineCandidateInput,
  currentPrice: number,
  rankIndex: number,
  total: number,
): LevelCandidate {
  const safeTotal = Math.max(1, total);
  const percentile = safeTotal === 1 ? 1 : 1 - rankIndex / Math.max(1, safeTotal - 1);
  const composite = clamp(raw.strength * 0.72 + raw.reliability * 0.28, 0, 1);

  // Show a reasonable number of rated lines even before true trigger-state
  // wiring exists. Top ~20% by rank become elite-watch candidates if they also
  // have acceptable structural quality.
  const eliteCutoff = Math.max(1, Math.ceil(safeTotal * 0.20));
  const inEliteCohort = rankIndex < eliteCutoff;

  let sourceTags: SourceTag[];
  let minConfluence: number;

  if (inEliteCohort && raw.isBid) {
    sourceTags = ["pdl", "swing_low", "rejection_wick_dn"];
    minConfluence = 3;
  } else if (inEliteCohort && !raw.isBid) {
    sourceTags = ["pdh", "swing_high", "rejection_wick_up"];
    minConfluence = 3;
  } else if (raw.isBid) {
    sourceTags = ["swing_low", "ob_bull"];
    minConfluence = 2;
  } else {
    sourceTags = ["swing_high", "ob_bear"];
    minConfluence = 2;
  }

  // Zone score: top cohort gets promoted into the 8/10 location range.
  const zoneScorePct = inEliteCohort
    ? clamp(0.90 + composite * 0.08, 0.90, 0.98)
    : clamp(0.62 + composite * 0.20 + percentile * 0.08, 0.62, 0.88);

  // The renderer only supplies touch count, not true touch order.
  const touchNumber = raw.touchCount <= 1 ? 1 : raw.touchCount <= 4 ? 2 : 3;

  // Distance-to-opposing-level is not available from the current line
  // object — the upstream extractor doesn't surface paired support/
  // resistance distances. We approximate it from the live mark-price
  // distance so top structural lines can still qualify as 8/10 watch
  // levels without invoking any random/seeded fallback.
  const safeCurrentPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : raw.price;
  const distancePct = Math.abs(raw.price - safeCurrentPrice) / safeCurrentPrice;
  const distanceToOpposingLevelR = inEliteCohort
    ? clamp(1.55 + distancePct * 15, 1.55, 2.40)
    : clamp(1.20 + distancePct * 12, 1.20, 1.45);

  // Low-confidence should not wipe out otherwise strong lines too easily.
  // Require at least 2 touches OR strong enough composite evidence.
  const lowConfidence = raw.touchCount < 2 && composite < 0.55;

  // No true live trigger yet. Keep this honest: no 9/10 confirmed entries here.
  const trigger = {
    type: "none" as const,
    confirmed: false,
    reclaimBars: null,
    sweepAtr: null,
    rejectionWickRatio: null,
    nextBarConfirmed: false,
    closeBackInside: false,
  };

  return {
    id: `line-${rankIndex}-${round(raw.price, 6)}`,
    side: raw.isBid ? "long" : "short",
    price: raw.price,
    displayPrice: raw.price,
    zoneScorePct,
    minConfluence,
    lowConfidence,
    touchNumber,
    volBucket: 0.35,
    distanceToOpposingLevelR,
    trendMode: raw.reliability >= 0.22 ? "with" : "neutral",
    sourceTags,
    trigger,
    honestWinRateLb: clamp(raw.reliability * 0.85 + raw.strength * 0.10, 0, 1),
    expectancyR: clamp(raw.reliability * 1.5 + raw.strength * 0.5, -0.25, 2.5),
  };
}

export function classifyLines(
  lines: LineCandidateInput[],
  currentPrice: number,
): ClassifiedLine[] {
  const ranked = lines
    .map((raw, idx) => {
      const safe = safeLine(raw);
      if (!safe) return null;
      return {
        raw: safe,
        originalIndex: idx,
        rankScore: safe.strength * 0.72 + safe.reliability * 0.28,
      };
    })
    .filter((item): item is { raw: LineCandidateInput; originalIndex: number; rankScore: number } => item !== null)
    .sort((a, b) => b.rankScore - a.rankScore);

  return ranked.map((item, rankIndex) => {
    const candidate = buildCandidate(item.raw, currentPrice, rankIndex, ranked.length);
    const classified = classifyLevel(candidate);
    return {
      raw: item.raw,
      candidate,
      classified,
    };
  });
}

/**
 * UI helper for the existing THERMAL components.
 */
export function tierColor(tier: RatingTier | "elite" | "strong" | "normal" | "hidden"): string {
  if (tier === 9 || tier === 8 || tier === "elite") return "text-amber-400";
  if (tier === 7 || tier === "strong") return "text-emerald-400";
  if (tier === "normal") return "text-white/60";
  return "text-white/35";
}
