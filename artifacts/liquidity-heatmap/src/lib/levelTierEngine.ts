/**
 * levelTierEngine.ts
 *
 * Drop-in TypeScript module for a React/Vite/Replit website.
 *
 * Purpose:
 * - Classify reversal levels into 9/10, 8/10, 7/10, or hidden
 * - Gate chart display so only elite/strong levels render by default
 * - Keep location quality separate from trigger quality
 * - Provide stable colors/styles for a lightweight chart overlay system
 *
 * Core ideas implemented from the research spec:
 * - 9/10 = Elite level + confirmed reclaim-style trigger
 * - 8/10 = Elite level without full trigger confirmation yet
 * - 7/10 = Strong level with reclaim/rejection confirmation
 * - Hidden = everything else
 *
 * This file is intentionally framework-agnostic. Import it from your chart,
 * scanner, or API layer.
 */

export type Side = "long" | "short";
export type TrendMode = "with" | "against" | "neutral";
export type TriggerType =
  | "none"
  | "sweep_reclaim"
  | "rejection_close"
  | "confirm_break"
  | "retest_after_reclaim";

export type SourceTag =
  | "swing_high"
  | "swing_low"
  | "rejection_wick_up"
  | "rejection_wick_dn"
  | "ob_bull"
  | "ob_bear"
  | "pdh"
  | "pdl"
  | "pwh"
  | "pwl"
  | "polarity_flip"
  | "fvg_bull"
  | "fvg_bear"
  | "volume_node"
  | "equal_highs"
  | "equal_lows"
  | "liquidity_void"
  | "fib_retracement"
  | "round_number";

export type RatingTier = 9 | 8 | 7 | 0;

export interface TriggerState {
  type: TriggerType;
  confirmed: boolean;
  reclaimBars: number | null;
  sweepAtr: number | null;
  rejectionWickRatio: number | null;
  nextBarConfirmed: boolean;
  closeBackInside: boolean;
}

export interface LevelCandidate {
  id: string;
  side: Side;
  price: number;
  displayPrice?: number;

  // Statistical location quality
  zoneScorePct: number; // 0.0 - 1.0 percentile score
  minConfluence: number;
  lowConfidence: boolean;
  touchNumber: number;
  volBucket: number; // 0.0 - 1.0 where 1.0 = highest vol regime bucket
  distanceToOpposingLevelR: number;
  trendMode: TrendMode;

  // Structural sources used in confluence
  sourceTags: SourceTag[];

  // Trigger / execution quality
  trigger: TriggerState;

  // Optional live context / scoring extensions
  honestWinRateLb?: number; // 0.0 - 1.0 conservative WR lower bound
  expectancyR?: number; // post-fee expectancy estimate
}

export interface TierRule {
  minZoneScorePct: number;
  maxZoneScorePct?: number;
  minConfluence: number;
  requireLowConfidenceFalse: boolean;
  allowedTouchNumbers: number[];
  requireTriggerConfirmed: boolean;
  maxVolBucket?: number;
  minSweepAtr?: number;
  maxSweepAtr?: number;
  maxReclaimBars?: number;
  minRRToOpposing?: number;
  allowedTriggers?: TriggerType[];
}

export const TIER_RULES: Record<RatingTier, TierRule | null> = {
  9: {
    minZoneScorePct: 0.9,
    minConfluence: 2,
    requireLowConfidenceFalse: true,
    allowedTouchNumbers: [1, 2],
    requireTriggerConfirmed: true,
    maxVolBucket: 0.8,
    minSweepAtr: 0.05,
    maxSweepAtr: 0.2,
    maxReclaimBars: 2,
    minRRToOpposing: 1.5,
    allowedTriggers: ["sweep_reclaim", "rejection_close", "confirm_break", "retest_after_reclaim"],
  },
  8: {
    minZoneScorePct: 0.9,
    minConfluence: 2,
    requireLowConfidenceFalse: true,
    allowedTouchNumbers: [1, 2],
    requireTriggerConfirmed: false,
    maxVolBucket: 0.8,
    minRRToOpposing: 1.5,
  },
  7: {
    minZoneScorePct: 0.7,
    maxZoneScorePct: 0.899999,
    minConfluence: 2,
    requireLowConfidenceFalse: true,
    allowedTouchNumbers: [1, 2],
    requireTriggerConfirmed: true,
    maxVolBucket: 0.85,
    minSweepAtr: 0.05,
    maxSweepAtr: 0.25,
    maxReclaimBars: 3,
    minRRToOpposing: 1.25,
    allowedTriggers: ["sweep_reclaim", "rejection_close", "confirm_break", "retest_after_reclaim"],
  },
  0: null,
};

/**
 * Higher-quality source families to use for promotion.
 * Secondary sources can still appear, but these are the best starting whitelist.
 */
export const PRIMARY_SOURCE_WHITELIST: SourceTag[] = [
  "swing_high",
  "swing_low",
  "rejection_wick_up",
  "rejection_wick_dn",
  "ob_bull",
  "ob_bear",
  "pdh",
  "pdl",
  "pwh",
  "pwl",
  "polarity_flip",
];

/**
 * Strong but secondary structural helpers.
 */
export const SECONDARY_SOURCE_WHITELIST: SourceTag[] = [
  "fvg_bull",
  "fvg_bear",
  "volume_node",
  "equal_highs",
  "equal_lows",
  "liquidity_void",
  "fib_retracement",
];

/**
 * Whitelisted elite pair/triple combinations from the research spec.
 * Order does not matter; combinations are normalized before matching.
 */
export const ELITE_COMBOS: readonly SourceTag[][] = [
  ["pdh", "rejection_wick_up"],
  ["pdl", "rejection_wick_dn"],
  ["pwh", "rejection_wick_up"],
  ["pwl", "rejection_wick_dn"],
  ["swing_low", "ob_bull"],
  ["swing_high", "ob_bear"],
  ["polarity_flip", "rejection_wick_dn"],
  ["polarity_flip", "rejection_wick_up"],
  ["pdl", "swing_low", "rejection_wick_dn"],
  ["pdh", "swing_high", "rejection_wick_up"],
  ["pwl", "swing_low", "ob_bull"],
  ["pwh", "swing_high", "ob_bear"],
  ["fvg_bull", "ob_bull", "rejection_wick_dn"],
  ["fvg_bear", "ob_bear", "rejection_wick_up"],
] as const;

/**
 * Strong but not elite pair/triple combinations.
 */
export const STRONG_COMBOS: readonly SourceTag[][] = [
  ["fvg_bull", "volume_node"],
  ["fvg_bear", "volume_node"],
  ["equal_lows", "rejection_wick_dn"],
  ["equal_highs", "rejection_wick_up"],
  ["swing_low", "volume_node"],
  ["swing_high", "volume_node"],
  ["pdl", "ob_bull"],
  ["pdh", "ob_bear"],
  ["fvg_bull", "ob_bull"],
  ["fvg_bear", "ob_bear"],
] as const;

export interface DisplayStyle {
  tier: RatingTier;
  lineWidth: number;
  color: string;
  opacity: number;
  plot: boolean;
  label: "elite" | "strong" | "hidden";
}

export const DISPLAY_STYLES: Record<RatingTier, DisplayStyle> = {
  9: {
    tier: 9,
    lineWidth: 3,
    color: "#D4A017", // gold
    opacity: 1,
    plot: true,
    label: "elite",
  },
  8: {
    tier: 8,
    lineWidth: 3,
    color: "#D4A017", // gold
    opacity: 0.92,
    plot: true,
    label: "elite",
  },
  7: {
    tier: 7,
    lineWidth: 2,
    color: "#2EAF66", // green
    opacity: 0.95,
    plot: true,
    label: "strong",
  },
  0: {
    tier: 0,
    lineWidth: 1,
    color: "#9AA0A6",
    opacity: 0.35,
    plot: false,
    label: "hidden",
  },
};

export interface ClassifiedLevel {
  level: LevelCandidate;
  rating: RatingTier;
  style: DisplayStyle;
  plot: boolean;
  reasons: string[];
}

function normalizeCombo(tags: SourceTag[]): string {
  return [...new Set((tags ?? []).filter((tag): tag is SourceTag => typeof tag === "string"))].sort().join("|");
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function safeLevel(level: LevelCandidate): LevelCandidate | null {
  if (!level || !finite(level.price) || level.price <= 0) return null;
  const trigger = level.trigger ?? {
    type: "none" as const,
    confirmed: false,
    reclaimBars: null,
    sweepAtr: null,
    rejectionWickRatio: null,
    nextBarConfirmed: false,
    closeBackInside: false,
  };
  return {
    ...level,
    displayPrice: finite(level.displayPrice) && level.displayPrice > 0 ? level.displayPrice : undefined,
    zoneScorePct: finite(level.zoneScorePct) ? Math.min(1, Math.max(0, level.zoneScorePct)) : 0,
    minConfluence: finite(level.minConfluence) ? Math.max(0, Math.floor(level.minConfluence)) : 0,
    lowConfidence: level.lowConfidence === true,
    touchNumber: finite(level.touchNumber) ? Math.max(0, Math.floor(level.touchNumber)) : 0,
    volBucket: finite(level.volBucket) ? Math.min(1, Math.max(0, level.volBucket)) : 1,
    distanceToOpposingLevelR: finite(level.distanceToOpposingLevelR) ? Math.max(0, level.distanceToOpposingLevelR) : 0,
    sourceTags: Array.isArray(level.sourceTags) ? level.sourceTags : [],
    trigger: {
      ...trigger,
      confirmed: trigger.confirmed === true,
      reclaimBars: finite(trigger.reclaimBars) ? Math.max(0, Math.floor(trigger.reclaimBars)) : null,
      sweepAtr: finite(trigger.sweepAtr) ? Math.max(0, trigger.sweepAtr) : null,
      rejectionWickRatio: finite(trigger.rejectionWickRatio) ? Math.max(0, trigger.rejectionWickRatio) : null,
      nextBarConfirmed: trigger.nextBarConfirmed === true,
      closeBackInside: trigger.closeBackInside === true,
    },
  };
}

const ELITE_COMBO_SET = new Set(ELITE_COMBOS.map(normalizeCombo));
const STRONG_COMBO_SET = new Set(STRONG_COMBOS.map(normalizeCombo));

function matchesCombo(sourceTags: SourceTag[], combos: Set<string>): boolean {
  const unique = [...new Set(sourceTags)];

  // check all combinations of length 2 and 3 only; this is the practical sweet spot
  const pairsAndTriples: SourceTag[][] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      pairsAndTriples.push([unique[i], unique[j]]);
      for (let k = j + 1; k < unique.length; k++) {
        pairsAndTriples.push([unique[i], unique[j], unique[k]]);
      }
    }
  }

  return pairsAndTriples.some((combo) => combos.has(normalizeCombo(combo)));
}

export function isEliteCombo(sourceTags: SourceTag[]): boolean {
  return matchesCombo(sourceTags, ELITE_COMBO_SET);
}

export function isStrongCombo(sourceTags: SourceTag[]): boolean {
  return matchesCombo(sourceTags, STRONG_COMBO_SET) || isEliteCombo(sourceTags);
}

export function hasPrimarySource(sourceTags: SourceTag[]): boolean {
  return sourceTags.some((tag) => PRIMARY_SOURCE_WHITELIST.includes(tag));
}

export function hasSecondarySource(sourceTags: SourceTag[]): boolean {
  return sourceTags.some((tag) => SECONDARY_SOURCE_WHITELIST.includes(tag));
}

function passesRule(level: LevelCandidate, rule: TierRule, tier: RatingTier, reasons: string[]): boolean {
  if (level.zoneScorePct < rule.minZoneScorePct) {
    reasons.push(`tier ${tier}: zoneScorePct < ${rule.minZoneScorePct}`);
    return false;
  }
  if (rule.maxZoneScorePct !== undefined && level.zoneScorePct > rule.maxZoneScorePct) {
    reasons.push(`tier ${tier}: zoneScorePct > ${rule.maxZoneScorePct}`);
    return false;
  }
  if (level.minConfluence < rule.minConfluence) {
    reasons.push(`tier ${tier}: minConfluence < ${rule.minConfluence}`);
    return false;
  }
  if (rule.requireLowConfidenceFalse && level.lowConfidence) {
    reasons.push(`tier ${tier}: lowConfidence must be false`);
    return false;
  }
  if (!rule.allowedTouchNumbers.includes(level.touchNumber)) {
    reasons.push(`tier ${tier}: touchNumber ${level.touchNumber} not allowed`);
    return false;
  }
  if (rule.maxVolBucket !== undefined && level.volBucket > rule.maxVolBucket) {
    reasons.push(`tier ${tier}: volBucket > ${rule.maxVolBucket}`);
    return false;
  }
  if (rule.minRRToOpposing !== undefined && level.distanceToOpposingLevelR < rule.minRRToOpposing) {
    reasons.push(`tier ${tier}: distanceToOpposingLevelR < ${rule.minRRToOpposing}`);
    return false;
  }
  if (rule.requireTriggerConfirmed && !level.trigger.confirmed) {
    reasons.push(`tier ${tier}: trigger not confirmed`);
    return false;
  }
  if (rule.allowedTriggers && !rule.allowedTriggers.includes(level.trigger.type)) {
    reasons.push(`tier ${tier}: trigger type ${level.trigger.type} not allowed`);
    return false;
  }
  if (rule.minSweepAtr !== undefined) {
    const sweep = level.trigger.sweepAtr;
    if (sweep === null || sweep < rule.minSweepAtr) {
      reasons.push(`tier ${tier}: sweepAtr < ${rule.minSweepAtr}`);
      return false;
    }
  }
  if (rule.maxSweepAtr !== undefined) {
    const sweep = level.trigger.sweepAtr;
    if (sweep === null || sweep > rule.maxSweepAtr) {
      reasons.push(`tier ${tier}: sweepAtr > ${rule.maxSweepAtr}`);
      return false;
    }
  }
  if (rule.maxReclaimBars !== undefined) {
    const reclaimBars = level.trigger.reclaimBars;
    if (reclaimBars === null || reclaimBars > rule.maxReclaimBars) {
      reasons.push(`tier ${tier}: reclaimBars > ${rule.maxReclaimBars}`);
      return false;
    }
  }

  return true;
}

/**
 * Production classifier.
 *
 * Tier precedence:
 * 9 -> 8 -> 7 -> hidden
 *
 * Additional gating beyond the rule block:
 * - 9 and 8 must come from elite-combo-quality source structure
 * - 7 must come from at least strong-combo-quality source structure
 */
export function classifyLevel(level: LevelCandidate): ClassifiedLevel {
  const reasons: string[] = [];
  const safe = safeLevel(level);
  if (!safe) {
    return {
      level,
      rating: 0,
      style: DISPLAY_STYLES[0],
      plot: false,
      reasons: ["hidden: invalid level payload"],
    };
  }
  level = safe;

  const eliteCombo = isEliteCombo(level.sourceTags);
  const strongCombo = isStrongCombo(level.sourceTags);

  const rule9 = TIER_RULES[9]!;
  if (eliteCombo && passesRule(level, rule9, 9, reasons)) {
    return {
      level,
      rating: 9,
      style: DISPLAY_STYLES[9],
      plot: DISPLAY_STYLES[9].plot,
      reasons: ["9/10: elite combo + confirmed reclaim/rejection trigger"],
    };
  }

  const rule8 = TIER_RULES[8]!;
  if (eliteCombo && passesRule(level, rule8, 8, reasons)) {
    return {
      level,
      rating: 8,
      style: DISPLAY_STYLES[8],
      plot: DISPLAY_STYLES[8].plot,
      reasons: ["8/10: elite location without full trigger confirmation yet"],
    };
  }

  const rule7 = TIER_RULES[7]!;
  if (strongCombo && passesRule(level, rule7, 7, reasons)) {
    return {
      level,
      rating: 7,
      style: DISPLAY_STYLES[7],
      plot: DISPLAY_STYLES[7].plot,
      reasons: ["7/10: strong location with confirmed reclaim/rejection trigger"],
    };
  }

  return {
    level,
    rating: 0,
    style: DISPLAY_STYLES[0],
    plot: false,
    reasons: reasons.length > 0 ? reasons : ["hidden: insufficient structure or trigger quality"],
  };
}

/**
 * Default plot gating for the chart.
 *
 * - show 9/10 and 8/10 always
 * - show 7/10 only when near price unless explicitly overridden
 */
export function shouldPlotLevel(args: {
  classified: ClassifiedLevel;
  currentPrice: number;
  nearPricePct?: number;
  showStrongAwayFromPrice?: boolean;
}): boolean {
  const { classified, currentPrice, nearPricePct = 0.03, showStrongAwayFromPrice = false } = args;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (classified.rating === 9 || classified.rating === 8) return true;
  if (classified.rating === 7) {
    if (showStrongAwayFromPrice) return true;
    const deltaPct = Math.abs(classified.level.price - currentPrice) / currentPrice;
    return deltaPct <= nearPricePct;
  }
  return false;
}

/**
 * Convenience helper for chart overlays.
 */
export function getChartLineProps(classified: ClassifiedLevel) {
  return {
    y: Number.isFinite(classified.level.displayPrice) ? classified.level.displayPrice : classified.level.price,
    stroke: classified.style.color,
    strokeWidth: classified.style.lineWidth,
    opacity: classified.style.opacity,
  };
}

/**
 * Convenience helper for API/scanner output.
 */
export function summarizeLevel(classified: ClassifiedLevel) {
  return {
    id: classified.level.id,
    rating: classified.rating,
    label: classified.style.label,
    side: classified.level.side,
    price: classified.level.price,
    displayPrice: classified.level.displayPrice ?? classified.level.price,
    zoneScorePct: classified.level.zoneScorePct,
    confluence: classified.level.minConfluence,
    lowConfidence: classified.level.lowConfidence,
    touchNumber: classified.level.touchNumber,
    sourceTags: classified.level.sourceTags,
    triggerType: classified.level.trigger.type,
    triggerConfirmed: classified.level.trigger.confirmed,
    reasons: classified.reasons,
  };
}

/**
 * Example usage inside a chart component:
 *
 * const classified = levels.map(classifyLevel);
 * const visible = classified.filter((c) => shouldPlotLevel({ classified: c, currentPrice }));
 * visible.map((c) => drawLine(getChartLineProps(c)))
 */

/**
 * Example level payloads for quick testing.
 */
export const DEMO_LEVELS: LevelCandidate[] = [
  {
    id: "elite-confirmed-long",
    side: "long",
    price: 31260,
    displayPrice: 31258,
    zoneScorePct: 0.94,
    minConfluence: 3,
    lowConfidence: false,
    touchNumber: 1,
    volBucket: 0.62,
    distanceToOpposingLevelR: 1.9,
    trendMode: "with",
    sourceTags: ["pdl", "swing_low", "rejection_wick_dn"],
    trigger: {
      type: "sweep_reclaim",
      confirmed: true,
      reclaimBars: 1,
      sweepAtr: 0.11,
      rejectionWickRatio: 1.8,
      nextBarConfirmed: true,
      closeBackInside: true,
    },
    honestWinRateLb: 0.71,
    expectancyR: 1.82,
  },
  {
    id: "elite-watch-short",
    side: "short",
    price: 73080,
    displayPrice: 73075,
    zoneScorePct: 0.92,
    minConfluence: 2,
    lowConfidence: false,
    touchNumber: 2,
    volBucket: 0.58,
    distanceToOpposingLevelR: 1.7,
    trendMode: "with",
    sourceTags: ["pdh", "rejection_wick_up"],
    trigger: {
      type: "none",
      confirmed: false,
      reclaimBars: null,
      sweepAtr: null,
      rejectionWickRatio: null,
      nextBarConfirmed: false,
      closeBackInside: false,
    },
    honestWinRateLb: 0.69,
    expectancyR: 1.24,
  },
  {
    id: "strong-confirmed-long",
    side: "long",
    price: 30640,
    displayPrice: 30638,
    zoneScorePct: 0.81,
    minConfluence: 2,
    lowConfidence: false,
    touchNumber: 2,
    volBucket: 0.74,
    distanceToOpposingLevelR: 1.4,
    trendMode: "with",
    sourceTags: ["fvg_bull", "volume_node"],
    trigger: {
      type: "rejection_close",
      confirmed: true,
      reclaimBars: 2,
      sweepAtr: 0.18,
      rejectionWickRatio: 1.6,
      nextBarConfirmed: true,
      closeBackInside: true,
    },
    honestWinRateLb: 0.63,
    expectancyR: 1.09,
  },
];
