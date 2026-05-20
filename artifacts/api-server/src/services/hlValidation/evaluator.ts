// Trade-outcome evaluator. Given a level and the FORWARD-ONLY bar slice
// after detection, compute outcome (win / loss / timeout), R-multiple,
// MAE/MFE, archetype, entry model.
//
// VALIDATION-ONLY. Pure function over candles. Anti-lookahead by
// construction — only sees `forwardBars`.

import type { OhlcvBar } from "../engines/levels";
import { computeAtr } from "../engines/levels";
import type {
  EntryModel, Outcome, Side, TouchArchetype, TradeRecord, BenchmarkKind,
} from "./types";
import { computeCostMetrics } from "./costMetrics";

export interface EvaluateInputs {
  symbol: string;
  interval: string;
  side: Side;
  levelTier: TradeRecord["levelTier"];
  benchmarkKind?: BenchmarkKind;
  level: number;
  detectionBars: OhlcvBar[];   // bars THROUGH detection (used for ATR + tolerance)
  forwardBars: OhlcvBar[];     // bars AFTER detection only — never include past
  tpR: number;
  slAtrMult: number;
  timeoutBars: number;
  feeBps: number;
  slippageBps: number;
  fold: number;
  detectionBarTime: number;
  minRiskBps?: number;
  maxCostToRiskRatio?: number;
}

export function evaluateTrade(inp: EvaluateInputs): TradeRecord | null {
  const { side, level, detectionBars, forwardBars, tpR, slAtrMult, timeoutBars,
    feeBps, slippageBps, symbol, interval, levelTier, benchmarkKind, fold,
    detectionBarTime } = inp;
  if (forwardBars.length === 0) return null;
  const atr = computeAtr(detectionBars, 14);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const tolerance = Math.max(atr * 0.25, level * 0.0005);

  // Find first touch in forwardBars.
  let entryIdx = -1;
  for (let i = 0; i < forwardBars.length; i++) {
    const b = forwardBars[i]!;
    if (b.low <= level + tolerance && b.high >= level - tolerance) { entryIdx = i; break; }
  }
  if (entryIdx < 0) return null;
  const entryBar = forwardBars[entryIdx]!;

  // Slippage applied at entry on the worse side.
  const slipMul = slippageBps / 10_000;
  const entryPrice = side === "long" ? level * (1 + slipMul) : level * (1 - slipMul);

  // Stop placement: invalidation distance OR slAtrMult*ATR, whichever is tighter.
  // Invalidation = tolerance band edge on the wrong side.
  const atrStopDist = atr * slAtrMult;
  const invalidationDist = tolerance + atr * 0.15;
  const stopDist = Math.max(level * 0.0005, Math.min(atrStopDist, invalidationDist));
  const stopPrice = side === "long" ? entryPrice - stopDist : entryPrice + stopDist;
  const targetPrice = side === "long"
    ? entryPrice + stopDist * tpR
    : entryPrice - stopDist * tpR;

  let outcome: Outcome = "timeout";
  let exitIdx = Math.min(entryIdx + timeoutBars, forwardBars.length - 1);
  let exitPrice = forwardBars[exitIdx]!.close;
  let mae = 0;
  let mfe = 0;

  for (let i = entryIdx; i <= Math.min(entryIdx + timeoutBars, forwardBars.length - 1); i++) {
    const b = forwardBars[i]!;
    // Track MAE/MFE (in raw price)
    if (side === "long") {
      const adv = (entryPrice - b.low);
      const fav = (b.high - entryPrice);
      if (adv > mae) mae = adv;
      if (fav > mfe) mfe = fav;
      // Conservative resolution if both touched in same bar: assume stop first.
      if (b.low <= stopPrice && b.high >= targetPrice) { outcome = "loss"; exitIdx = i; exitPrice = stopPrice; break; }
      if (b.low <= stopPrice) { outcome = "loss"; exitIdx = i; exitPrice = stopPrice; break; }
      if (b.high >= targetPrice) { outcome = "win"; exitIdx = i; exitPrice = targetPrice; break; }
    } else {
      const adv = (b.high - entryPrice);
      const fav = (entryPrice - b.low);
      if (adv > mae) mae = adv;
      if (fav > mfe) mfe = fav;
      if (b.high >= stopPrice && b.low <= targetPrice) { outcome = "loss"; exitIdx = i; exitPrice = stopPrice; break; }
      if (b.high >= stopPrice) { outcome = "loss"; exitIdx = i; exitPrice = stopPrice; break; }
      if (b.low <= targetPrice) { outcome = "win"; exitIdx = i; exitPrice = targetPrice; break; }
    }
  }

  const grossR = side === "long"
    ? (exitPrice - entryPrice) / stopDist
    : (entryPrice - exitPrice) / stopDist;
  const feeR = ((feeBps / 10_000) * 2 * entryPrice) / stopDist;  // round-trip
  const rMultiple = grossR - feeR;
  const pctMove = side === "long"
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;

  // Archetype: how deep was the wick relative to ATR?
  const wickDepth = side === "long" ? Math.max(0, entryBar.open - entryBar.low) : Math.max(0, entryBar.high - entryBar.open);
  let archetype: TouchArchetype = "first-touch";
  if (entryIdx >= 3) archetype = "retest";
  if (wickDepth > atr * 0.6) archetype = "deep-wick";
  else if (wickDepth < atr * 0.15) archetype = "shallow-wick";

  // Entry model: rejection (close moved away from level same bar),
  // reclaim (close back across level after a wick through),
  // retest (entry on a later bar after initial touch).
  const closeAwayLong = side === "long" && entryBar.close > level;
  const closeAwayShort = side === "short" && entryBar.close < level;
  let entryModel: EntryModel = "rejection";
  if (entryIdx >= 1) entryModel = "retest";
  if (!(closeAwayLong || closeAwayShort) && entryIdx === 0) entryModel = "reclaim";

  const cost = computeCostMetrics({
    side, entryPrice, stopPrice, targetPrice,
    feeBps, slippageBps,
    rawR: grossR, netR: rMultiple,
    minRiskBps: inp.minRiskBps, maxCostToRiskRatio: inp.maxCostToRiskRatio,
  });

  return {
    symbol, interval, side, levelTier, benchmarkKind,
    detectionBarTime,
    entryBarTime: entryBar.time * 1000,
    entryPrice, stopPrice, targetPrice,
    exitBarTime: forwardBars[exitIdx]!.time * 1000,
    exitPrice, outcome,
    rMultiple, pctMove,
    bars: exitIdx - entryIdx + 1,
    mae: mae / stopDist,
    mfe: mfe / stopDist,
    archetype, entryModel,
    fold,
    rawR: cost.rawR,
    costR: cost.costR,
    netR: cost.netR,
    riskDistanceBps: cost.riskDistanceBps,
    targetDistanceBps: cost.targetDistanceBps,
    roundTripCostBps: cost.roundTripCostBps,
    costToRiskRatio: cost.costToRiskRatio,
    minimumTradeableRiskPassed: cost.minimumTradeableRiskPassed,
  };
}
