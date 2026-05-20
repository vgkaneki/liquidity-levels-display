// In-process job manager for historical & forward validation runs.
// VALIDATION-ONLY.

import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger";
import { profileSpec } from "./profiles";
import { engineConfigHash, engineGitSha, VALIDATION_SUITE_VERSION } from "./version";
import { fetchHistoricalSeries, isFetchDeadlineError } from "./dataFetcher";
import { describeCacheRoot } from "./seriesCache";
import { runWalkForwardOnSeries } from "./walkForward";
import { runAntiLookahead } from "./antiLookahead";
import { snapshotLiveRegistry, compareSnapshots } from "./mutationCheck";
import { renderReport, writeReportToDisk, writeJournalCsv, reportPathFor } from "./report";
import type {
  ProfileName, RunConfig, RunStatus, TradeRecord, FoldStat, SeriesFetchOutcome,
} from "./types";
import type { OhlcvBar } from "../engines/levels";

interface JobHandle {
  status: RunStatus;
  cfg: RunConfig;
  abort: AbortController;
}

class JobManager {
  private jobs = new Map<string, JobHandle>();
  private order: string[] = [];   // most-recent-first

  list(limit = 10): RunStatus[] {
    return this.order.slice(0, limit).map((id) => this.jobs.get(id)!.status);
  }

  get(runId: string): RunStatus | undefined {
    return this.jobs.get(runId)?.status;
  }

  cancel(runId: string): boolean {
    const h = this.jobs.get(runId);
    if (!h) return false;
    if (h.status.phase === "done" || h.status.phase === "failed" || h.status.phase === "cancelled") return false;
    h.abort.abort();
    h.status.phase = "cancelled";
    h.status.finishedAt = Date.now();
    return true;
  }

  start(profile: ProfileName, overrides?: Partial<RunConfig>): RunStatus {
    const runId = randomUUID().slice(0, 8);
    const spec = profileSpec(profile);
    const cfg: RunConfig = {
      runId,
      startedAt: Date.now(),
      profile,
      symbols: spec.symbols,
      intervals: spec.intervals,
      lookbackDays: spec.lookbackDays,
      folds: spec.folds,
      tpR: 1.5,
      slAtrMult: 1.0,
      timeoutBars: 12,
      feeBps: 5,
      slippageBps: 3,
      staleSampleMin: 30,
      moderateSampleMin: 100,
      headlineSampleMin: 300,
      engineConfigHash: engineConfigHash(),
      engineGitSha: engineGitSha(),
      validationSuiteVersion: VALIDATION_SUITE_VERSION,
      ...(overrides ?? {}),
    };
    const status: RunStatus = {
      runId, profile, phase: "queued", progress: 0, startedAt: cfg.startedAt, errors: [],
      fetchOutcomes: [],
      cacheStats: { cacheHits: 0, networkFetches: 0, failures: 0, cacheRoot: describeCacheRoot() },
    };
    const h: JobHandle = { status, cfg, abort: new AbortController() };
    this.jobs.set(runId, h);
    this.order.unshift(runId);
    if (this.order.length > 25) {
      const drop = this.order.pop()!;
      this.jobs.delete(drop);
    }
    void this.execute(h, spec.maxRunMinutes, spec.maxFetchMinutes).catch((e) => {
      logger.error({ err: e, runId }, "hl-validation: run failed");
      h.status.phase = "failed";
      h.status.errors.push((e as Error).message);
      h.status.finishedAt = Date.now();
    });
    return status;
  }

  private async execute(h: JobHandle, maxRunMinutes: number, maxFetchMinutes: number): Promise<void> {
    const { cfg, status, abort } = h;
    const runDeadlineMs = cfg.startedAt + maxRunMinutes * 60_000;
    const fetchDeadlineMs = cfg.startedAt + maxFetchMinutes * 60_000;

    const beforeSnap = await snapshotLiveRegistry(cfg.symbols);

    status.phase = "fetching-data";
    const series: Array<{ coin: string; interval: string; bars: OhlcvBar[]; windowStartMs: number; windowEndMs: number; cacheHit: boolean }> = [];
    const totalSeriesJobs = cfg.symbols.length * cfg.intervals.length;
    let done = 0;
    for (const coin of cfg.symbols) {
      for (const interval of cfg.intervals) {
        if (abort.signal.aborted) return;
        const t0 = Date.now();
        let lastBarsSoFar = 0;
        const outcome: SeriesFetchOutcome = {
          coin, interval, status: "failed", bars: 0,
          windowStartMs: 0, windowEndMs: 0, durationMs: 0, source: "hyperliquid",
        };
        try {
          const f = await fetchHistoricalSeries(coin, interval, cfg.lookbackDays, {
            signal: abort.signal,
            deadlineMs: Math.min(runDeadlineMs, fetchDeadlineMs),
            useCache: true,
            onProgress: (n) => { lastBarsSoFar = n; },
          });
          series.push({ coin: f.coin, interval: f.interval, bars: f.bars, windowStartMs: f.windowStartMs, windowEndMs: f.windowEndMs, cacheHit: f.cacheHit });
          outcome.status = f.cacheHit ? "cache" : "ok";
          outcome.bars = f.bars.length;
          outcome.windowStartMs = f.windowStartMs;
          outcome.windowEndMs = f.windowEndMs;
          if (f.cacheHit) status.cacheStats!.cacheHits++;
          else status.cacheStats!.networkFetches++;
        } catch (e) {
          if (isFetchDeadlineError(e)) {
            outcome.status = "skipped-deadline";
            outcome.bars = lastBarsSoFar;
            outcome.errorMessage = `fetch deadline reached with ${lastBarsSoFar} bars buffered`;
            status.errors.push(`fetch ${coin}@${interval}: deadline reached after ${lastBarsSoFar} bars`);
            status.watchdog = {
              kind: "maxFetchMinutes",
              elapsedMs: Date.now() - cfg.startedAt,
              limitMs: maxFetchMinutes * 60_000,
              inFlight: { coin, interval, barsFetchedSoFar: lastBarsSoFar },
            };
          } else {
            outcome.status = "failed";
            outcome.errorMessage = (e as Error).message;
            status.errors.push(`fetch ${coin}@${interval}: ${(e as Error).message}`);
            status.cacheStats!.failures++;
          }
        }
        outcome.durationMs = Date.now() - t0;
        status.fetchOutcomes!.push(outcome);
        done++;
        status.progress = Math.min(0.5, done / Math.max(1, totalSeriesJobs) * 0.5);

        // Hard run-watchdog: if we've blown past maxRunMinutes during the
        // fetch phase, fail the whole run gracefully NOW with full
        // disclosure of which series was in flight and how many bars
        // were collected. This prevents the "stuck at 25% for hours"
        // pathology when HL is heavily throttling.
        if (Date.now() >= runDeadlineMs) {
          status.watchdog = status.watchdog ?? {
            kind: "maxRunMinutes",
            elapsedMs: Date.now() - cfg.startedAt,
            limitMs: maxRunMinutes * 60_000,
            inFlight: { coin, interval, barsFetchedSoFar: lastBarsSoFar },
          };
          status.errors.push(`run deadline (${maxRunMinutes}m) exceeded during fetch phase`);
          await this.finalizeWatchdogRun(h, beforeSnap, series);
          return;
        }
      }
    }

    if (series.length === 0) {
      status.errors.push("no series fetched — see fetchOutcomes for per-series reasons");
      status.phase = "failed";
      status.finishedAt = Date.now();
      return;
    }

    status.phase = "anti-lookahead";
    const antiLookaheadSamples = profileSpec(cfg.profile).antiLookaheadSamples;
    const antiLookahead = runAntiLookahead(series, antiLookaheadSamples);
    status.progress = 0.55;

    status.phase = "walk-forward";
    const trades: TradeRecord[] = [];
    const benchmarkTrades: TradeRecord[] = [];
    const folds: FoldStat[] = [];
    let i = 0;
    for (const s of series) {
      if (abort.signal.aborted) return;
      const r = runWalkForwardOnSeries({ symbol: s.coin, interval: s.interval, bars: s.bars, cfg, signal: abort.signal });
      trades.push(...r.trades);
      benchmarkTrades.push(...r.benchmarkTrades);
      folds.push(...r.folds);
      i++;
      status.progress = 0.55 + (i / Math.max(1, series.length)) * 0.4;
      if (Date.now() >= runDeadlineMs) {
        status.watchdog = {
          kind: "maxRunMinutes",
          elapsedMs: Date.now() - cfg.startedAt,
          limitMs: maxRunMinutes * 60_000,
          inFlight: { coin: s.coin, interval: s.interval, barsFetchedSoFar: s.bars.length },
        };
        status.errors.push(`run deadline (${maxRunMinutes}m) exceeded during walk-forward at ${s.coin}@${s.interval}`);
        break;
      }
    }

    status.phase = "writing-report";
    const liveProbe = await this.probeLiveData();
    const afterSnap = await snapshotLiveRegistry(cfg.symbols);
    const mutation = compareSnapshots(beforeSnap, afterSnap);
    const { mdPath, csvPath } = reportPathFor(cfg.runId, "historical");
    writeJournalCsv(csvPath, trades);
    const rendered = renderReport({
      cfg,
      series: series.map((s) => ({ coin: s.coin, interval: s.interval, bars: s.bars.length, windowStartMs: s.windowStartMs, windowEndMs: s.windowEndMs, cacheHit: s.cacheHit })),
      trades, benchmarkTrades, folds,
      antiLookahead, mutation, liveProbe,
      journalPath: csvPath,
      fetchOutcomes: status.fetchOutcomes ?? [],
      cacheStats: status.cacheStats!,
      watchdog: status.watchdog,
    });
    writeReportToDisk(mdPath, rendered.markdown);

    status.phase = "done";
    status.progress = 1;
    status.finishedAt = Date.now();
    status.reportPath = mdPath;
    status.journalPath = csvPath;
    status.resultClass = rendered.resultClass;
    status.headline = rendered.headline;
  }

  // When a watchdog fires during fetch we still want a downloadable
  // report explaining what happened. Renders an early-termination
  // markdown report so the operator gets the same artifact surface.
  private async finalizeWatchdogRun(
    h: JobHandle,
    beforeSnap: Awaited<ReturnType<typeof snapshotLiveRegistry>>,
    series: Array<{ coin: string; interval: string; bars: OhlcvBar[]; windowStartMs: number; windowEndMs: number; cacheHit: boolean }>,
  ): Promise<void> {
    const { cfg, status } = h;
    status.phase = "writing-report";
    const liveProbe = await this.probeLiveData();
    const afterSnap = await snapshotLiveRegistry(cfg.symbols);
    const mutation = compareSnapshots(beforeSnap, afterSnap);
    const { mdPath, csvPath } = reportPathFor(cfg.runId, "historical");
    writeJournalCsv(csvPath, []);
    const rendered = renderReport({
      cfg,
      series: series.map((s) => ({ coin: s.coin, interval: s.interval, bars: s.bars.length, windowStartMs: s.windowStartMs, windowEndMs: s.windowEndMs, cacheHit: s.cacheHit })),
      trades: [], benchmarkTrades: [], folds: [],
      antiLookahead: { passed: true, cases: [], notes: ["watchdog terminated run before anti-lookahead phase"] },
      mutation, liveProbe,
      journalPath: csvPath,
      fetchOutcomes: status.fetchOutcomes ?? [],
      cacheStats: status.cacheStats!,
      watchdog: status.watchdog,
    });
    writeReportToDisk(mdPath, rendered.markdown);
    status.phase = "failed";
    status.finishedAt = Date.now();
    status.reportPath = mdPath;
    status.journalPath = csvPath;
  }

  private async probeLiveData(): Promise<{ hlServerLatencyMs: number; missingBarPct: number; checkedAt: number; ok: boolean }> {
    const t0 = Date.now();
    try {
      const { fetchCandles } = await import("../hyperliquid");
      const c = await fetchCandles("BTC", "1h", 24 * 60 * 60_000);
      const elapsed = Date.now() - t0;
      const missing = c.length === 0 ? 1 : Math.max(0, (24 - c.length) / 24);
      return { hlServerLatencyMs: elapsed, missingBarPct: missing, checkedAt: Date.now(), ok: c.length > 0 };
    } catch {
      return { hlServerLatencyMs: Date.now() - t0, missingBarPct: 1, checkedAt: Date.now(), ok: false };
    }
  }
}

export const hlValidationJobs: JobManager = new JobManager();
