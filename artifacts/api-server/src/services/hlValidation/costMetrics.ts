// Cost-vs-risk diagnostics, derived from each trade's geometry and the
// run's fee/slippage assumptions. VALIDATION-ONLY — never feeds engines.

import type { Side } from "./types";

export interface CostMetricsInputs {
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  feeBps: number;
  slippageBps: number;
  rawR: number;          // grossR (before fees)
  netR: number;          // rMultiple after fees (== rawR - feeR)
  minRiskBps?: number;
  maxCostToRiskRatio?: number;
}

export interface CostMetrics {
  rawR: number;
  costR: number;
  netR: number;
  riskDistanceBps: number;
  targetDistanceBps: number;
  roundTripCostBps: number;
  costToRiskRatio: number;
  minimumTradeableRiskPassed: boolean;
}

export function computeCostMetrics(inp: CostMetricsInputs): CostMetrics {
  const { side, entryPrice, stopPrice, targetPrice, feeBps, slippageBps,
    rawR, netR, minRiskBps, maxCostToRiskRatio } = inp;
  const stopDist = Math.abs(entryPrice - stopPrice);
  const tgtDist = Math.abs(targetPrice - entryPrice);
  const riskDistanceBps = entryPrice > 0 ? (stopDist / entryPrice) * 10_000 : 0;
  const targetDistanceBps = entryPrice > 0 ? (tgtDist / entryPrice) * 10_000 : 0;
  const roundTripCostBps = 2 * feeBps + 2 * slippageBps;
  const costToRiskRatio = riskDistanceBps > 0 ? roundTripCostBps / riskDistanceBps : Infinity;
  const costR = rawR - netR; // by construction in evaluator
  const sideOk = side === "long" || side === "short"; // satisfies linter; side already validated upstream
  const minRiskOk = minRiskBps == null ? true : riskDistanceBps >= minRiskBps;
  const ratioOk = maxCostToRiskRatio == null ? true : costToRiskRatio <= maxCostToRiskRatio;
  return {
    rawR, costR, netR,
    riskDistanceBps, targetDistanceBps, roundTripCostBps, costToRiskRatio,
    minimumTradeableRiskPassed: sideOk && minRiskOk && ratioOk,
  };
}
