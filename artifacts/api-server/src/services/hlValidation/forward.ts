// Forward paper-trading mode. Runs in a separate job class so its
// outputs are NEVER blended with historical results. Polls live HL
// candles at a fixed cadence, opens paper trades when newly-detected
// engine levels are touched, tracks them through TP/SL/timeout, and
// writes a separate report.
//
// VALIDATION-ONLY. Paper-only — does not touch any live PnL system.

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../../lib/logger";
import { fetchCandles, intervalToLookbackMs } from "../hyperliquid";
import { discoverLevelsAt, computeAtr } from "./engineAdapter";
import type { OhlcvBar } from "../engines/levels";
import { engineConfigHash, engineGitSha, VALIDATION_SUITE_VERSION } from "./version";
import { reportPathFor } from "./report";
import type { ForwardConfig, ForwardStatus, Side, TradeRecord } from "./types";
import { computeCostMetrics } from "./costMetrics";
import { proportion, expectancyR, fmtPct, fmtR } from "./stats";

interface OpenPosition {
  symbol: string; interval: string; side: Side; entryPrice: number;
  stopPrice: number; targetPrice: number; entryBarTime: number; barsHeld: number;
  detectionBarTime: number; tpR: number;
}

interface ForwardJob {
  status: ForwardStatus;
  cfg: ForwardConfig;
  abort: AbortController;
  open: OpenPosition[];
  closed: TradeRecord[];
}

class ForwardManager {
  private jobs = new Map<string, ForwardJob>();
  private order: string[] = [];

  list(limit = 10): ForwardStatus[] { return this.order.slice(0, limit).map((id) => this.jobs.get(id)!.status); }
  get(runId: string): ForwardStatus | undefined { return this.jobs.get(runId)?.status; }

  cancel(runId: string): boolean {
    const j = this.jobs.get(runId);
    if (!j) return false;
    if (j.status.phase === "done" || j.status.phase === "failed" || j.status.phase === "cancelled") return false;
    j.abort.abort();
    j.status.phase = "cancelled";
    j.status.finishedAt = Date.now();
    this.writeReport(j);
    return true;
  }

  start(opts: {
    symbols?: string[]; intervals?: string[]; durationMs?: number; pollMs?: number;
    tpR?: number; slAtrMult?: number; timeoutBars?: number; feeBps?: number; slippageBps?: number;
  }): ForwardStatus {
    const runId = randomUUID().slice(0, 8);
    const cfg: ForwardConfig = {
      runId, startedAt: Date.now(),
      symbols: opts.symbols ?? ["BTC", "ETH", "SOL"],
      intervals: opts.intervals ?? ["15m", "1h"],
      durationMs: opts.durationMs ?? 60 * 60_000,
      pollMs: opts.pollMs ?? 60_000,
      tpR: opts.tpR ?? 1.5, slAtrMult: opts.slAtrMult ?? 1.0,
      timeoutBars: opts.timeoutBars ?? 12,
      feeBps: opts.feeBps ?? 5, slippageBps: opts.slippageBps ?? 3,
      engineConfigHash: engineConfigHash(),
      engineGitSha: engineGitSha(),
      validationSuiteVersion: VALIDATION_SUITE_VERSION,
    };
    const status: ForwardStatus = { runId, phase: "queued", startedAt: cfg.startedAt, ticks: 0, openPositions: 0, closedTrades: 0, errors: [] };
    const j: ForwardJob = { status, cfg, abort: new AbortController(), open: [], closed: [] };
    this.jobs.set(runId, j);
    this.order.unshift(runId);
    if (this.order.length > 25) { const d = this.order.pop()!; this.jobs.delete(d); }
    void this.run(j).catch((e) => {
      logger.error({ err: e, runId }, "hl-validation: forward run failed");
      j.status.phase = "failed";
      j.status.errors.push((e as Error).message);
      j.status.finishedAt = Date.now();
      this.writeReport(j);
    });
    return status;
  }

  private async run(j: ForwardJob): Promise<void> {
    j.status.phase = "running";
    const endAt = j.cfg.startedAt + j.cfg.durationMs;
    while (Date.now() < endAt && !j.abort.signal.aborted) {
      for (const symbol of j.cfg.symbols) {
        for (const interval of j.cfg.intervals) {
          try { await this.tick(j, symbol, interval); }
          catch (e) { j.status.errors.push(`tick ${symbol}@${interval}: ${(e as Error).message}`); }
        }
      }
      j.status.ticks++;
      j.status.openPositions = j.open.length;
      j.status.closedTrades = j.closed.length;
      await sleep(j.cfg.pollMs, j.abort.signal);
    }
    if (j.status.phase === "running") j.status.phase = "done";
    j.status.finishedAt = Date.now();
    this.writeReport(j);
  }

  private async tick(j: ForwardJob, symbol: string, interval: string): Promise<void> {
    const lookbackMs = intervalToLookbackMs(interval, 400);
    const candles = await fetchCandles(symbol, interval, lookbackMs);
    if (candles.length < 100) return;
    const bars: OhlcvBar[] = candles.map((c) => ({
      time: Math.floor(c.t / 1000), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
    }));
    const detIdx = bars.length - 1;

    // Step open positions through the latest bar first.
    const lastBar = bars[bars.length - 1]!;
    const stillOpen: OpenPosition[] = [];
    for (const p of j.open) {
      if (p.symbol !== symbol || p.interval !== interval) { stillOpen.push(p); continue; }
      let outcome: "win" | "loss" | "timeout" | null = null;
      let exitPrice = lastBar.close;
      if (p.side === "long") {
        if (lastBar.low <= p.stopPrice) { outcome = "loss"; exitPrice = p.stopPrice; }
        else if (lastBar.high >= p.targetPrice) { outcome = "win"; exitPrice = p.targetPrice; }
      } else {
        if (lastBar.high >= p.stopPrice) { outcome = "loss"; exitPrice = p.stopPrice; }
        else if (lastBar.low <= p.targetPrice) { outcome = "win"; exitPrice = p.targetPrice; }
      }
      p.barsHeld++;
      if (!outcome && p.barsHeld >= j.cfg.timeoutBars) outcome = "timeout";
      if (!outcome) { stillOpen.push(p); continue; }
      const stopDist = Math.abs(p.entryPrice - p.stopPrice);
      const grossR = p.side === "long" ? (exitPrice - p.entryPrice) / stopDist : (p.entryPrice - exitPrice) / stopDist;
      const feeR = ((j.cfg.feeBps / 10_000) * 2 * p.entryPrice) / stopDist;
      const netR = grossR - feeR;
      const cost = computeCostMetrics({
        side: p.side, entryPrice: p.entryPrice, stopPrice: p.stopPrice, targetPrice: p.targetPrice,
        feeBps: j.cfg.feeBps, slippageBps: j.cfg.slippageBps, rawR: grossR, netR,
      });
      j.closed.push({
        symbol: p.symbol, interval: p.interval, side: p.side, levelTier: "normal",
        detectionBarTime: p.detectionBarTime,
        entryBarTime: p.entryBarTime, entryPrice: p.entryPrice, stopPrice: p.stopPrice, targetPrice: p.targetPrice,
        exitBarTime: lastBar.time * 1000, exitPrice, outcome,
        rMultiple: netR, pctMove: (exitPrice - p.entryPrice) / p.entryPrice * (p.side === "long" ? 1 : -1),
        bars: p.barsHeld, mae: 0, mfe: 0,
        archetype: "first-touch", entryModel: "rejection", fold: 0,
        rawR: cost.rawR, costR: cost.costR, netR: cost.netR,
        riskDistanceBps: cost.riskDistanceBps, targetDistanceBps: cost.targetDistanceBps,
        roundTripCostBps: cost.roundTripCostBps, costToRiskRatio: cost.costToRiskRatio,
        minimumTradeableRiskPassed: cost.minimumTradeableRiskPassed,
      });
    }
    j.open = stillOpen;

    // Open new positions when newly-discovered levels are touched THIS bar.
    const levels = discoverLevelsAt({ bars: bars.slice(0, detIdx), detectionIndex: detIdx });
    const atr = computeAtr(bars, 14);
    if (!Number.isFinite(atr) || atr <= 0) return;
    for (const lev of levels) {
      const side: Side = lev.price <= lastBar.close ? "long" : "short";
      const tol = Math.max(atr * 0.25, lev.price * 0.0005);
      const touched = lastBar.low <= lev.price + tol && lastBar.high >= lev.price - tol;
      if (!touched) continue;
      // Skip if we already have a position for this exact level.
      if (j.open.some((p) => p.symbol === symbol && p.interval === interval && Math.abs(p.entryPrice - lev.price) <= tol)) continue;
      const stopDist = Math.max(lev.price * 0.0005, Math.min(atr * j.cfg.slAtrMult, tol + atr * 0.15));
      const slip = j.cfg.slippageBps / 10_000;
      const entryPrice = side === "long" ? lev.price * (1 + slip) : lev.price * (1 - slip);
      const stopPrice = side === "long" ? entryPrice - stopDist : entryPrice + stopDist;
      const targetPrice = side === "long" ? entryPrice + stopDist * j.cfg.tpR : entryPrice - stopDist * j.cfg.tpR;
      j.open.push({
        symbol, interval, side, entryPrice, stopPrice, targetPrice,
        entryBarTime: lastBar.time * 1000, barsHeld: 0,
        detectionBarTime: lastBar.time * 1000, tpR: j.cfg.tpR,
      });
    }
  }

  private writeReport(j: ForwardJob): void {
    const { mdPath } = reportPathFor(j.cfg.runId, "forward");
    const wins = j.closed.filter((t) => t.outcome === "win").length;
    const w = proportion(wins, j.closed.length);
    const expR = expectancyR(j.closed.map((t) => t.rMultiple));
    const lines: string[] = [];
    lines.push(`# Hyperliquid Forward Paper-Trading Report`);
    lines.push(``);
    lines.push(`- Run ID: \`${j.cfg.runId}\``);
    lines.push(`- Started: ${new Date(j.cfg.startedAt).toISOString()}`);
    lines.push(`- Ended: ${j.status.finishedAt ? new Date(j.status.finishedAt).toISOString() : "(in progress)"}`);
    lines.push(`- Phase: \`${j.status.phase}\``);
    lines.push(`- Engine git SHA: \`${j.cfg.engineGitSha}\` · config hash: \`${j.cfg.engineConfigHash}\` · suite v\`${j.cfg.validationSuiteVersion}\``);
    lines.push(`- Symbols: ${j.cfg.symbols.join(", ")} · intervals: ${j.cfg.intervals.join(", ")}`);
    lines.push(``);
    lines.push(`## Headline`);
    lines.push(`- Closed trades: ${j.closed.length} (wins ${wins})`);
    lines.push(`- Win rate: ${fmtPct(w.p)} · 95% CI [${fmtPct(w.low95)}, ${fmtPct(w.high95)}] · sample \`${w.label}\``);
    lines.push(`- Expectancy: ${fmtR(expR)}`);
    lines.push(`- Open positions at report time: ${j.open.length}`);
    lines.push(``);
    lines.push(`## Trade journal (CSV)`);
    lines.push(``);
    const header = ["symbol","interval","side","entryBarTime","entryPrice","stopPrice","targetPrice","exitBarTime","exitPrice","outcome","rMultiple"];
    lines.push("```csv");
    lines.push(header.join(","));
    for (const t of j.closed) {
      lines.push([t.symbol, t.interval, t.side, t.entryBarTime, t.entryPrice, t.stopPrice, t.targetPrice, t.exitBarTime, t.exitPrice, t.outcome, t.rMultiple].join(","));
    }
    lines.push("```");
    lines.push(``);
    lines.push(`> Forward paper results are kept SEPARATE from historical validation reports and are never blended.`);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, lines.join("\n"), "utf8");
    j.status.reportPath = mdPath;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export const hlValidationForwardJobs: ForwardManager = new ForwardManager();
