// Markdown report renderer — 16 sections per spec.
// VALIDATION-ONLY.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  proportion, fmtPct, fmtR, expectancyR, sampleLabel, lowSampleWarning,
} from "./stats";
import type {
  RunConfig, TradeRecord, FoldStat, ResultClass, SeriesFetchOutcome, RunStatus,
} from "./types";
import type { AntiLookaheadReport } from "./antiLookahead";
import type { MutationVerdict } from "./mutationCheck";
import { aggregateBenchmarkByKind } from "./walkForward";

export interface ReportInputs {
  cfg: RunConfig;
  series: Array<{ coin: string; interval: string; bars: number; windowStartMs: number; windowEndMs: number; cacheHit?: boolean }>;
  trades: TradeRecord[];
  benchmarkTrades: TradeRecord[];
  folds: FoldStat[];
  antiLookahead: AntiLookaheadReport;
  mutation: MutationVerdict;
  liveProbe: { hlServerLatencyMs: number; missingBarPct: number; checkedAt: number; ok: boolean };
  forwardReportLink?: string;
  journalPath: string;
  fetchOutcomes?: SeriesFetchOutcome[];
  cacheStats?: NonNullable<RunStatus["cacheStats"]>;
  watchdog?: RunStatus["watchdog"];
}

export interface ReportOutput {
  markdown: string;
  resultClass: ResultClass;
  headline: {
    expectancyR: number;
    sampleSize: number;
    foldCount: number;
    winRate: number;
    winRateLow95: number;
    winRateHigh95: number;
  };
}

function classify(headlineN: number, headlineWinRate: number, beatBenchmark: boolean,
  antiLookaheadOk: boolean, dataOk: boolean): ResultClass {
  if (!antiLookaheadOk) return "anti-lookahead-failed";
  if (!dataOk) return "data-integrity-failed";
  if (headlineN < 30) return "very-low-sample";
  if (!beatBenchmark) return "below-benchmark";
  if (headlineN < 100) return "low-confidence";
  if (headlineN < 300) return "moderate-confidence";
  return headlineWinRate > 0.5 ? "headline-eligible" : "below-benchmark";
}

function tableRow(cells: (string | number)[]): string {
  return "| " + cells.map((c) => String(c)).join(" | ") + " |";
}

export function renderReport(inp: ReportInputs): ReportOutput {
  const { cfg, series, trades, benchmarkTrades, folds, antiLookahead, mutation, liveProbe, fetchOutcomes, cacheStats, watchdog } = inp;

  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const timeouts = trades.filter((t) => t.outcome === "timeout").length;
  const winRate = proportion(wins, trades.length);
  const expR = expectancyR(trades.map((t) => t.rMultiple));

  const benchByKind = aggregateBenchmarkByKind(benchmarkTrades);
  const benchWinRates: Record<string, ReturnType<typeof proportion>> = {};
  const benchExpR: Record<string, number> = {};
  for (const [kind, rs] of Object.entries(benchByKind)) {
    const bw = rs.filter((t) => t.outcome === "win").length;
    benchWinRates[kind] = proportion(bw, rs.length);
    benchExpR[kind] = expectancyR(rs.map((t) => t.rMultiple));
  }
  const bestBenchExpR = Object.values(benchExpR).reduce((m, v) => Math.max(m, v), -Infinity);
  const beatBenchmark = expR > bestBenchExpR;

  const dataOk = liveProbe.ok && series.every((s) => s.bars > 50);
  const resultClass = classify(trades.length, winRate.p, beatBenchmark, antiLookahead.passed, dataOk);

  const lines: string[] = [];
  lines.push(`# Hyperliquid Validation Report`);
  lines.push(``);
  lines.push(`- Run ID: \`${cfg.runId}\``);
  lines.push(`- Started: ${new Date(cfg.startedAt).toISOString()}`);
  lines.push(`- Profile: \`${cfg.profile}\``);
  lines.push(`- Engine git SHA: \`${cfg.engineGitSha}\` · config hash: \`${cfg.engineConfigHash}\` · suite v\`${cfg.validationSuiteVersion}\``);
  lines.push(``);

  // 1. Executive summary
  lines.push(`## 1. Executive Summary`);
  lines.push(``);
  if (cfg.profile === "smoke") {
    lines.push(`> **NON-STATISTICAL — infrastructure proof only.** The \`smoke\` profile`);
    lines.push(`> exists to verify that the validation pipeline (HL fetch → cache → walk-forward`);
    lines.push(`> → benchmarks → mutation check → report write) is operational end-to-end.`);
    lines.push(`> Its sample size is intentionally too small to draw any conclusion about`);
    lines.push(`> engine quality. Use \`quick\` or \`standard\` for analysis.`);
    lines.push(``);
  }
  lines.push(`- **Result classification:** \`${resultClass}\``);
  lines.push(`- **Total trades:** ${trades.length} (wins ${wins} / losses ${losses} / timeouts ${timeouts})`);
  lines.push(`- **Win rate:** ${fmtPct(winRate.p)} · 95% CI [${fmtPct(winRate.low95)}, ${fmtPct(winRate.high95)}] · sample label: \`${winRate.label}\``);
  lines.push(`- **Expectancy:** ${fmtR(expR)} per trade`);
  lines.push(`- **Best benchmark expectancy:** ${fmtR(bestBenchExpR)} → engine ${beatBenchmark ? "**beats**" : "**does NOT beat**"} best benchmark`);
  lines.push(`- **Anti-lookahead:** ${antiLookahead.passed ? "PASSED" : "FAILED"} (${antiLookahead.cases.length} cases)`);
  lines.push(`- **Live-state mutation check:** ${mutation.passed ? "passed" : "delta observed"}${mutation.partial ? " (PARTIAL — see §14)" : ""}`);
  const warn = lowSampleWarning(trades.length);
  if (warn) lines.push(`- ⚠ ${warn}`);
  lines.push(``);

  // 2. Run config + engine fingerprint
  lines.push(`## 2. Run Configuration & Engine Fingerprint`);
  lines.push(``);
  lines.push("```json");
  lines.push(JSON.stringify({
    profile: cfg.profile, symbols: cfg.symbols, intervals: cfg.intervals,
    lookbackDays: cfg.lookbackDays, folds: cfg.folds,
    tpR: cfg.tpR, slAtrMult: cfg.slAtrMult, timeoutBars: cfg.timeoutBars,
    feeBps: cfg.feeBps, slippageBps: cfg.slippageBps,
    sampleSizeThresholds: { veryLow: cfg.staleSampleMin, moderate: cfg.moderateSampleMin, headline: cfg.headlineSampleMin },
    engineGitSha: cfg.engineGitSha, engineConfigHash: cfg.engineConfigHash,
    validationSuiteVersion: cfg.validationSuiteVersion,
    dataSource: "hyperliquid-only",
  }, null, 2));
  lines.push("```");
  lines.push(``);

  // 3. HL data coverage
  lines.push(`## 3. Hyperliquid Data Coverage & Integrity`);
  lines.push(``);
  lines.push(`Hyperliquid is the **only** data source. No OKX, no Toobit, no KCEX, no synthetic, no fallback.`);
  lines.push(``);
  lines.push(tableRow(["symbol", "interval", "bars", "window start (UTC)", "window end (UTC)", "source"]));
  lines.push(tableRow(["---","---","---","---","---","---"]));
  for (const s of series) {
    const src = s.cacheHit ? "hyperliquid (validation-only on-disk cache)" : "hyperliquid (live fetch)";
    lines.push(tableRow([s.coin, s.interval, s.bars,
      new Date(s.windowStartMs).toISOString(),
      new Date(s.windowEndMs).toISOString(), src]));
  }
  lines.push(``);

  if (cacheStats) {
    lines.push(`### Validation-only series cache`);
    lines.push(``);
    lines.push(`- Cache root: \`${cacheStats.cacheRoot}\``);
    lines.push(`- Cache hits: **${cacheStats.cacheHits}** · Network fetches: **${cacheStats.networkFetches}** · Failures: **${cacheStats.failures}**`);
    lines.push(`- Isolation: this cache is read & written ONLY by the validation suite. The live engine's HL TtlCache is never touched. Cached payloads were originally fetched from Hyperliquid; replaying them is functionally equivalent to fetching them again (modulo HL throttling).`);
    lines.push(``);
  }

  if (fetchOutcomes && fetchOutcomes.length > 0) {
    lines.push(`### Per-series fetch outcomes`);
    lines.push(``);
    lines.push(tableRow(["symbol","interval","status","bars","duration (ms)","error"]));
    lines.push(tableRow(["---","---","---","---","---","---"]));
    for (const o of fetchOutcomes) {
      lines.push(tableRow([o.coin, o.interval, o.status, o.bars, o.durationMs, o.errorMessage ?? ""]));
    }
    lines.push(``);
  }

  if (watchdog) {
    lines.push(`### ⏱ Watchdog termination`);
    lines.push(``);
    lines.push(`- Kind: **${watchdog.kind}**`);
    lines.push(`- Elapsed: ${(watchdog.elapsedMs / 1000).toFixed(1)}s · Limit: ${(watchdog.limitMs / 1000).toFixed(0)}s`);
    if (watchdog.inFlight) {
      lines.push(`- In-flight series at termination: \`${watchdog.inFlight.coin}@${watchdog.inFlight.interval}\` (${watchdog.inFlight.barsFetchedSoFar} bars buffered)`);
    }
    lines.push(`- Recommended next step: re-kick once Hyperliquid throttling has eased, or use the validation-only on-disk cache populated by this partial run.`);
    lines.push(``);
  }

  // 4. Walk-forward
  lines.push(`## 4. Walk-Forward Validation`);
  lines.push(``);
  lines.push(tableRow(["fold","train end (UTC)","test end (UTC)","trades","wins","losses","timeouts","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---","---","---","---"]));
  for (const f of folds) {
    lines.push(tableRow([f.fold, new Date(f.trainEnd).toISOString(), new Date(f.testEnd).toISOString(),
      f.trades, f.wins, f.losses, f.timeouts, f.expectancyR.toFixed(3)]));
  }
  lines.push(``);

  // 5. Benchmark comparison
  lines.push(`## 5. Benchmark Comparison`);
  lines.push(``);
  lines.push(tableRow(["benchmark","trades","win rate","CI low","CI high","sample","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---","---","---"]));
  lines.push(tableRow(["**ENGINE**", trades.length, fmtPct(winRate.p), fmtPct(winRate.low95), fmtPct(winRate.high95), winRate.label, expR.toFixed(3)]));
  for (const [kind, rs] of Object.entries(benchByKind)) {
    const w = benchWinRates[kind]!;
    lines.push(tableRow([kind, rs.length, fmtPct(w.p), fmtPct(w.low95), fmtPct(w.high95), w.label, benchExpR[kind]!.toFixed(3)]));
  }
  lines.push(``);

  // 6. Per-symbol
  lines.push(`## 6. Symbol-by-Symbol Stats`);
  lines.push(``);
  lines.push(tableRow(["symbol","trades","win rate","CI","sample","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---","---"]));
  const bySym = new Map<string, TradeRecord[]>();
  for (const t of trades) (bySym.get(t.symbol) ?? bySym.set(t.symbol, []).get(t.symbol))!.push(t);
  for (const [sym, rs] of bySym) {
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([sym, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, w.label, expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 7. Per-timeframe
  lines.push(`## 7. Timeframe-by-Timeframe Stats`);
  lines.push(``);
  lines.push(tableRow(["interval","trades","win rate","CI","sample","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---","---"]));
  const byTf = new Map<string, TradeRecord[]>();
  for (const t of trades) (byTf.get(t.interval) ?? byTf.set(t.interval, []).get(t.interval))!.push(t);
  for (const [tf, rs] of byTf) {
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([tf, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, w.label, expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 8. Tier progression
  lines.push(`## 8. Tier Progression — Normal / Strong / Elite (deterministic-subset live tiering)`);
  lines.push(``);
  lines.push(`> **Tier validation mode: deterministic-subset live tiering.** Tiers below`);
  lines.push(`> come from the EXACT thresholds the production registry applies`);
  lines.push(`> (\`liveTierFromScore\`: ≥0.85 elite, ≥0.65 strong, ≥0.40 normal, else`);
  lines.push(`> filtered out). The engine adapter replays the **deterministic, history-only**`);
  lines.push(`> subset of the live pipeline (KDE on swing pivots with recency weights,`);
  lines.push(`> vol-scaled bandwidth, market-profile POC + value-area + recent swings`);
  lines.push(`> as raw levels, validated via \`validateLevel(gateLight)\`, then \`mergeIntoZones\`).`);
  lines.push(`>`);
  lines.push(`> **NOT replicated** (and therefore tier outcomes here may differ from`);
  lines.push(`> production for the same level): \`reg.multiplier\` strength scaling,`);
  lines.push(`> quantile-band raw levels, the strict gate (touches≥3, p<0.1) for`);
  lines.push(`> KDE/POC peaks, and post-merge zone adjustments (orderflow / higher-TF`);
  lines.push(`> aggregation / cross-asset confluence) plus the final \`score>0.3\` /`);
  lines.push(`> top-8 filter. Treat this section as validation of the **deterministic`);
  lines.push(`> core + threshold mapping**, not as production-identical tier parity.`);
  lines.push(`> See §17 for the path to full production parity.`);
  lines.push(``);
  lines.push(tableRow(["tier","trades","win rate","CI","sample","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---","---"]));
  for (const tier of ["normal","strong","elite"] as const) {
    const rs = trades.filter((t) => t.levelTier === tier);
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([tier, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, sampleLabel(rs.length), expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 9. Touch archetype
  lines.push(`## 9. Touch Archetype Tracking`);
  lines.push(``);
  lines.push(tableRow(["archetype","trades","win rate","CI","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---"]));
  for (const a of ["first-touch","retest","deep-wick","shallow-wick"] as const) {
    const rs = trades.filter((t) => t.archetype === a);
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([a, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 10. MAE / MFE
  lines.push(`## 10. MAE / MFE After Touch`);
  lines.push(``);
  const maes = trades.map((t) => t.mae);
  const mfes = trades.map((t) => t.mfe);
  const avg = (a: number[]): number => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  lines.push(`- Mean MAE (R units): ${avg(maes).toFixed(3)}`);
  lines.push(`- Mean MFE (R units): ${avg(mfes).toFixed(3)}`);
  lines.push(``);

  // 11. False vs clean break
  lines.push(`## 11. False-Break and Clean-Break Tracking`);
  lines.push(``);
  // A "false break" = price wicked through the level by > 0.5 ATR but
  // closed back beyond it (the trade ended in win OR timeout but MAE
  // exceeded 1.0R while still finishing positive). A "clean break" =
  // outcome=loss with MAE >= 1.0R AND price closed beyond the stop.
  const falseBreaks = trades.filter((t) => t.outcome !== "loss" && t.mae > 1.0);
  const cleanBreaks = trades.filter((t) => t.outcome === "loss" && t.mae >= 1.0);
  const fbProp = proportion(falseBreaks.length, trades.length);
  const cbProp = proportion(cleanBreaks.length, trades.length);
  lines.push(`- False-break rate: ${fmtPct(fbProp.p)} · CI [${fmtPct(fbProp.low95)}, ${fmtPct(fbProp.high95)}] · sample \`${fbProp.label}\``);
  lines.push(`- Clean-break rate: ${fmtPct(cbProp.p)} · CI [${fmtPct(cbProp.low95)}, ${fmtPct(cbProp.high95)}] · sample \`${cbProp.label}\``);
  lines.push(``);

  // 12. Entry models
  lines.push(`## 12. Entry Model Comparison — Rejection / Reclaim / Retest`);
  lines.push(``);
  lines.push(tableRow(["entry model","trades","win rate","CI","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---"]));
  for (const m of ["rejection","reclaim","retest"] as const) {
    const rs = trades.filter((t) => t.entryModel === m);
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([m, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 13. Regime-split
  lines.push(`## 13. Regime-Split Expectancy`);
  lines.push(``);
  lines.push(tableRow(["regime","trades","win rate","CI","expectancyR"]));
  lines.push(tableRow(["---","---","---","---","---"]));
  for (const r of ["trend-up","trend-down","range","high-vol","low-vol"] as const) {
    const rs = trades.filter((t) => t.regime === r);
    const w = proportion(rs.filter((t) => t.outcome === "win").length, rs.length);
    lines.push(tableRow([r, rs.length, fmtPct(w.p), `[${fmtPct(w.low95)},${fmtPct(w.high95)}]`, expectancyR(rs.map((t) => t.rMultiple)).toFixed(3)]));
  }
  lines.push(``);

  // 14. Live latency + integrity
  lines.push(`## 14. Live Latency & Data-Integrity Probe`);
  lines.push(``);
  lines.push(`- Hyperliquid round-trip latency: ${liveProbe.hlServerLatencyMs} ms`);
  lines.push(`- Probe time (UTC): ${new Date(liveProbe.checkedAt).toISOString()}`);
  lines.push(`- Missing-bar percentage: ${(liveProbe.missingBarPct * 100).toFixed(2)}%`);
  lines.push(``);
  lines.push(`### Anti-lookahead cases`);
  lines.push(``);
  lines.push(tableRow(["symbol","interval","t","ok","baseline #","with-future #"]));
  lines.push(tableRow(["---","---","---","---","---","---"]));
  for (const c of antiLookahead.cases) {
    lines.push(tableRow([c.symbol, c.interval, c.t, c.ok ? "✓" : "✗ FAIL", c.baselineCount, c.withFutureCount]));
  }
  lines.push(``);
  lines.push(`### Live-state mutation`);
  lines.push(``);
  // Hardening pass: PASSED iff (registry stats unchanged) AND (every
  // per-symbol digest unchanged) AND (every DB row count unchanged) AND
  // (no PARTIAL flag). PARTIAL otherwise — never silently promoted.
  const verdictLabel = mutation.passed
    ? "PASSED"
    : mutation.partial
      ? "PARTIAL"
      : "DELTA OBSERVED";
  lines.push(`- Verdict: **${verdictLabel}**`);
  lines.push(`- Registry stats changed: ${mutation.diff.statsChanged}`);
  lines.push(`- Symbols with digest delta: ${mutation.diff.digestChanges.length}`);
  lines.push(`- DB tables with row-count delta: ${mutation.diff.dbChanges.length}`);
  if (mutation.diff.dbChanges.length > 0) {
    for (const c of mutation.diff.dbChanges) {
      lines.push(`  - \`${c.table}\` before=${c.before} after=${c.after}`);
    }
  }
  for (const n of mutation.notes) lines.push(`  - _${n}_`);
  lines.push(``);

  // 15. Forward link
  lines.push(`## 15. Forward Paper-Trading Report`);
  lines.push(``);
  lines.push(inp.forwardReportLink ? `Latest forward report: \`${inp.forwardReportLink}\`` : `_No forward paper run linked to this historical run._`);
  lines.push(``);

  // 15b. Cost-vs-Risk Diagnostics
  lines.push(`## 15b. Cost-vs-Risk Diagnostics`);
  lines.push(``);
  lines.push(`Per-trade cost geometry. All fields are reporting-only; they are`);
  lines.push(`carried in the journal CSV alongside every trade and never feed any engine.`);
  lines.push(``);
  lines.push(`- \`rawR\` — gross R BEFORE fees / slippage`);
  lines.push(`- \`costR\` — round-trip fee + slippage cost expressed in R units`);
  lines.push(`- \`netR\` — realized R after costs (== \`rMultiple\`)`);
  lines.push(`- \`riskDistanceBps\` — stop distance as basis points of entry price`);
  lines.push(`- \`targetDistanceBps\` — target distance as basis points of entry price`);
  lines.push(`- \`roundTripCostBps\` — \`2 × feeBps + 2 × slippageBps\` (= **${(2 * cfg.feeBps + 2 * cfg.slippageBps).toFixed(1)} bps** for this run)`);
  lines.push(`- \`costToRiskRatio\` — \`roundTripCostBps / riskDistanceBps\` (lower is better; ≥ 1 means costs alone consume the entire stop)`);
  lines.push(`- \`minimumTradeableRiskPassed\` — boolean flag from the configurable filter (see below)`);
  lines.push(``);

  const tradesWithCost = trades.filter((t) => t.costToRiskRatio != null && Number.isFinite(t.costToRiskRatio));
  function summarize(label: string, list: typeof trades): string[] {
    const out: string[] = [];
    if (list.length === 0) {
      out.push(`- **${label}:** 0 trades`);
      return out;
    }
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length % 2 ? s[(s.length - 1) >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
    };
    const raws  = list.map((t) => t.rawR ?? 0);
    const nets  = list.map((t) => t.netR ?? t.rMultiple);
    const risks = list.map((t) => t.riskDistanceBps ?? 0);
    const ratios = list.map((t) => t.costToRiskRatio ?? 0);
    const passed = list.filter((t) => t.minimumTradeableRiskPassed === true).length;
    const w = proportion(list.filter((t) => t.outcome === "win").length, list.length);
    out.push(`- **${label}:** ${list.length} trades · win rate ${fmtPct(w.p)} [${fmtPct(w.low95)},${fmtPct(w.high95)}] · expectancyR ${fmtR(avg(nets))} (${sampleLabel(list.length)})`);
    out.push(`  · rawR avg ${fmtR(avg(raws))} → netR avg ${fmtR(avg(nets))} (avg costR drag = ${fmtR(avg(raws) - avg(nets))})`);
    out.push(`  · riskDistanceBps median **${med(risks).toFixed(1)}** (avg ${avg(risks).toFixed(1)}) · costToRiskRatio median **${med(ratios).toFixed(3)}** (avg ${avg(ratios).toFixed(3)})`);
    out.push(`  · minimumTradeableRiskPassed: ${passed} / ${list.length} (${fmtPct(passed / Math.max(1, list.length))})`);
    return out;
  }

  const filterEnabled = cfg.minRiskBps != null || cfg.maxCostToRiskRatio != null;
  if (filterEnabled) {
    lines.push(`### Filter configured`);
    lines.push(``);
    lines.push(`- \`minRiskBps\`: ${cfg.minRiskBps ?? "(unset)"}`);
    lines.push(`- \`maxCostToRiskRatio\`: ${cfg.maxCostToRiskRatio ?? "(unset)"}`);
    lines.push(``);
    lines.push(`Trades that fail the filter are **kept** in the journal (flagged via \`minimumTradeableRiskPassed=false\`). Stats are presented BEFORE and AFTER the filter so the impact is auditable.`);
    lines.push(``);
    const passing = tradesWithCost.filter((t) => t.minimumTradeableRiskPassed === true);
    summarize("Before filter (all trades)", trades).forEach((l) => lines.push(l));
    summarize("After filter (minimumTradeableRiskPassed only)", passing).forEach((l) => lines.push(l));
  } else {
    lines.push(`### Filter not configured (report-only mode)`);
    lines.push(``);
    lines.push(`No \`minRiskBps\` or \`maxCostToRiskRatio\` was supplied for this run. Per-trade flags are present in the CSV for downstream analysis, but no trades were excluded from headline statistics.`);
    lines.push(``);
    summarize("All trades", trades).forEach((l) => lines.push(l));
  }
  lines.push(``);

  // 16. Journal
  lines.push(`## 16. Trade / Touch Journal Export`);
  lines.push(``);
  lines.push(`Full journal (CSV) written to: \`${inp.journalPath}\``);
  lines.push(``);

  // 17. TODO — full production tier parity
  lines.push(`## 17. TODO — full production tier parity`);
  lines.push(``);
  lines.push(`This suite currently validates the **deterministic-subset live tiering**`);
  lines.push(`pipeline (see §8). Full production-identical tier validation would`);
  lines.push(`require one of the following, both currently out of scope:`);
  lines.push(``);
  lines.push(`1. **Frozen-fixture parity test against \`computeLevelsData\`.** Pre-record`);
  lines.push(`   the live engine's output (the full zone list, with scores and tiers)`);
  lines.push(`   for a stable historical window on a small set of symbols, then`);
  lines.push(`   assert that the harness's deterministic-subset slice of those zones`);
  lines.push(`   matches byte-for-byte. This catches drift in either direction`);
  lines.push(`   without the harness needing to reproduce live state.`);
  lines.push(`2. **A read-only public production output surface.** Expose a sealed`);
  lines.push(`   read-only function (e.g. \`computeLevelsData(symbol, interval, bars)\`)`);
  lines.push(`   that the harness can call deterministically on historical bars,`);
  lines.push(`   isolated from any live state writes. The harness would then assert`);
  lines.push(`   tier equality directly against the production code path.`);
  lines.push(``);
  lines.push(`Until one of those lands, every "tier" label produced by this suite`);
  lines.push(`should be read as **deterministic-subset live tier** — not as a`);
  lines.push(`guaranteed match for what production would emit on the same bars.`);
  lines.push(``);

  return {
    markdown: lines.join("\n"),
    resultClass,
    headline: {
      expectancyR: expR,
      sampleSize: trades.length,
      foldCount: folds.length,
      winRate: winRate.p,
      winRateLow95: winRate.low95,
      winRateHigh95: winRate.high95,
    },
  };
}

export function writeReportToDisk(filePath: string, markdown: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, markdown, "utf8");
}

export function writeJournalCsv(filePath: string, trades: TradeRecord[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const header = [
    "symbol","interval","side","levelTier","benchmarkKind","detectionBarTime",
    "entryBarTime","entryPrice","stopPrice","targetPrice","exitBarTime","exitPrice",
    "outcome","rMultiple","pctMove","bars","mae","mfe","archetype","entryModel",
    "regime","fold",
    // Cost-vs-risk diagnostics (completion-pass v2)
    "rawR","costR","netR","riskDistanceBps","targetDistanceBps",
    "roundTripCostBps","costToRiskRatio","minimumTradeableRiskPassed",
  ];
  const rows = trades.map((t) => header.map((h) => {
    const v = (t as unknown as Record<string, unknown>)[h];
    if (v == null) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    return typeof v === "number" ? String(v) : String(v).replace(/,/g, ";");
  }).join(","));
  writeFileSync(filePath, [header.join(","), ...rows].join("\n"), "utf8");
}

export function reportPathFor(runId: string, kind: "historical" | "forward" = "historical"): { mdPath: string; csvPath: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = process.env.HL_VALIDATION_REPORTS_DIR ?? join(process.cwd(), "reports", "hl-validation");
  const sub = kind === "forward" ? "forward" : ".";
  return {
    mdPath: join(dir, sub, `${ts}-${runId}.md`),
    csvPath: join(dir, sub, `${ts}-${runId}.journal.csv`),
  };
}

export { join as _joinPath };
