// Walk-forward run loop. Fold the deep series into K (train, test)
// windows, discover levels at the start of each test window using ONLY
// the train bars, evaluate trades on the test window, aggregate.
//
// VALIDATION-ONLY.

import type { OhlcvBar } from "../engines/levels";
import { discoverLevelsAt } from "./engineAdapter";
import { evaluateTrade } from "./evaluator";
import { generateBenchmarks } from "./benchmarks";
import type {
  FoldStat, RunConfig, TradeRecord, BenchmarkKind, RegimeLabel,
} from "./types";

export interface WalkForwardResult {
  trades: TradeRecord[];
  benchmarkTrades: TradeRecord[];
  folds: FoldStat[];
}

function regimeOf(bars: OhlcvBar[]): RegimeLabel {
  if (bars.length < 30) return "range";
  const slope = (bars[bars.length - 1]!.close - bars[0]!.close) / bars[0]!.close;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i]!.close / bars[i - 1]!.close));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const annVol = sd * Math.sqrt(365);
  if (annVol > 1.2) return "high-vol";
  if (annVol < 0.4) return "low-vol";
  if (slope > 0.05) return "trend-up";
  if (slope < -0.05) return "trend-down";
  return "range";
}

export interface RunSeriesInputs {
  symbol: string;
  interval: string;
  bars: OhlcvBar[];
  cfg: RunConfig;
  signal?: AbortSignal;
}

export function runWalkForwardOnSeries(inp: RunSeriesInputs): WalkForwardResult {
  const { symbol, interval, bars, cfg, signal } = inp;
  const trades: TradeRecord[] = [];
  const benchmarkTrades: TradeRecord[] = [];
  const folds: FoldStat[] = [];
  if (bars.length < 200) return { trades, benchmarkTrades, folds };

  // Test windows occupy the most recent 60% of the data, split into K folds.
  const trainBars = Math.floor(bars.length * 0.4);
  const testRegion = bars.length - trainBars;
  const foldSize = Math.floor(testRegion / cfg.folds);
  if (foldSize < 50) return { trades, benchmarkTrades, folds };

  for (let f = 0; f < cfg.folds; f++) {
    if (signal?.aborted) break;
    const detectionIdx = trainBars + f * foldSize;
    const testEndIdx = Math.min(detectionIdx + foldSize, bars.length);
    const trainSlice = bars.slice(0, detectionIdx);
    const forwardSlice = bars.slice(detectionIdx, testEndIdx);
    if (forwardSlice.length < cfg.timeoutBars + 1) continue;

    const levels = discoverLevelsAt({ bars: trainSlice, detectionIndex: detectionIdx });
    const regime = regimeOf(forwardSlice);

    let foldTrades = 0, foldWins = 0, foldLosses = 0, foldTimeouts = 0, foldR = 0;
    const detectionBarTime = bars[detectionIdx - 1]!.time * 1000;

    for (const lev of levels) {
      const lastClose = trainSlice[trainSlice.length - 1]!.close;
      const side = lev.price <= lastClose ? "long" : "short";
      const t = evaluateTrade({
        symbol, interval, side, levelTier: lev.tier, level: lev.price,
        detectionBars: trainSlice, forwardBars: forwardSlice,
        tpR: cfg.tpR, slAtrMult: cfg.slAtrMult, timeoutBars: cfg.timeoutBars,
        feeBps: cfg.feeBps, slippageBps: cfg.slippageBps,
        fold: f, detectionBarTime,
        minRiskBps: cfg.minRiskBps, maxCostToRiskRatio: cfg.maxCostToRiskRatio,
      });
      if (!t) continue;
      t.regime = regime;
      trades.push(t);
      foldTrades++; foldR += t.rMultiple;
      if (t.outcome === "win") foldWins++;
      else if (t.outcome === "loss") foldLosses++;
      else foldTimeouts++;
    }

    // Benchmarks — same fold, same forward window, count matched.
    const benches = generateBenchmarks(bars, detectionIdx, interval, levels.length || 6, `${symbol}|${interval}|${f}`);
    for (const b of benches) {
      const t = evaluateTrade({
        symbol, interval, side: b.side, levelTier: "benchmark", benchmarkKind: b.kind, level: b.price,
        detectionBars: trainSlice, forwardBars: forwardSlice,
        tpR: cfg.tpR, slAtrMult: cfg.slAtrMult, timeoutBars: cfg.timeoutBars,
        feeBps: cfg.feeBps, slippageBps: cfg.slippageBps,
        fold: f, detectionBarTime,
        minRiskBps: cfg.minRiskBps, maxCostToRiskRatio: cfg.maxCostToRiskRatio,
      });
      if (!t) continue;
      t.regime = regime;
      benchmarkTrades.push(t);
    }

    folds.push({
      fold: f,
      trainStart: bars[0]!.time * 1000,
      trainEnd: detectionBarTime,
      testStart: forwardSlice[0]!.time * 1000,
      testEnd: forwardSlice[forwardSlice.length - 1]!.time * 1000,
      trades: foldTrades,
      wins: foldWins,
      losses: foldLosses,
      timeouts: foldTimeouts,
      expectancyR: foldTrades > 0 ? foldR / foldTrades : 0,
    });
  }

  return { trades, benchmarkTrades, folds };
}

export function aggregateBenchmarkByKind(records: TradeRecord[]): Record<BenchmarkKind, TradeRecord[]> {
  const out: Partial<Record<BenchmarkKind, TradeRecord[]>> = {};
  for (const r of records) {
    if (!r.benchmarkKind) continue;
    (out[r.benchmarkKind] ??= []).push(r);
  }
  return out as Record<BenchmarkKind, TradeRecord[]>;
}
