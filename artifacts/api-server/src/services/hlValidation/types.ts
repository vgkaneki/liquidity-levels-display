// HL Validation — shared types.
// VALIDATION-ONLY. NEVER feeds the live engine.

export type ProfileName = "smoke" | "quick" | "standard" | "full";

// Per-series fetch outcome surfaced in the report and on failure paths.
export interface SeriesFetchOutcome {
  coin: string;
  interval: string;
  status: "ok" | "cache" | "failed" | "skipped-deadline";
  bars: number;
  windowStartMs: number;
  windowEndMs: number;
  durationMs: number;
  errorMessage?: string;
  source: "hyperliquid";        // never anything else
}

export type RunPhase =
  | "queued"
  | "fetching-data"
  | "anti-lookahead"
  | "walk-forward"
  | "benchmarks"
  | "writing-report"
  | "done"
  | "cancelled"
  | "failed";

export type ResultClass =
  | "headline-eligible"
  | "moderate-confidence"
  | "low-confidence"
  | "very-low-sample"
  | "below-benchmark"
  | "anti-lookahead-failed"
  | "data-integrity-failed";

export interface RunConfig {
  runId: string;
  startedAt: number;
  profile: ProfileName;
  symbols: string[];          // HL coin form, e.g. ["BTC","ETH","SOL"]
  intervals: string[];        // ["15m","1h",...]
  lookbackDays: number;
  folds: number;
  tpR: number;                // default 1.5
  slAtrMult: number;          // default 1.0
  timeoutBars: number;        // default 12
  feeBps: number;             // round-trip basis points
  slippageBps: number;
  staleSampleMin: number;     // 30
  moderateSampleMin: number;  // 100
  headlineSampleMin: number;  // 300
  // Cost-vs-risk filter (report-only by default; trades that fail the
  // filter are KEPT in the journal and FLAGGED via
  // `minimumTradeableRiskPassed=false`. If either threshold is set the
  // report produces an additional "after-filter" view side-by-side with
  // the unfiltered baseline so operators can see the impact.)
  minRiskBps?: number;            // e.g. 25 → require stop-distance ≥ 25 bps of price
  maxCostToRiskRatio?: number;    // e.g. 0.40 → roundTripCostBps / riskDistanceBps ≤ 0.40
  engineConfigHash: string;
  engineGitSha: string;
  validationSuiteVersion: string;
}

export interface RunStatus {
  runId: string;
  profile: ProfileName;
  phase: RunPhase;
  progress: number;            // 0..1
  startedAt: number;
  finishedAt?: number;
  message?: string;
  reportPath?: string;
  journalPath?: string;
  resultClass?: ResultClass;
  // Set when a watchdog (maxRunMinutes / maxFetchMinutes) terminates the run.
  // Carries the symbol/interval that was in flight so operators can re-kick
  // a tighter scope or wait for HL throttling to subside.
  watchdog?: {
    kind: "maxRunMinutes" | "maxFetchMinutes";
    elapsedMs: number;
    limitMs: number;
    inFlight?: { coin: string; interval: string; barsFetchedSoFar: number };
  };
  fetchOutcomes?: SeriesFetchOutcome[];
  cacheStats?: { cacheHits: number; networkFetches: number; failures: number; cacheRoot: string };
  headline?: {
    expectancyR: number;
    sampleSize: number;
    foldCount: number;
    winRate: number;
    winRateLow95: number;
    winRateHigh95: number;
  };
  errors: string[];
}

export type Side = "long" | "short";
export type Outcome = "win" | "loss" | "timeout";

export interface TradeRecord {
  symbol: string;
  interval: string;
  side: Side;
  levelTier: "elite" | "strong" | "normal" | "benchmark";
  benchmarkKind?: BenchmarkKind;
  detectionBarTime: number;     // ms
  entryBarTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitBarTime: number;
  exitPrice: number;
  outcome: Outcome;
  rMultiple: number;            // realized after fees/slippage (== netR)
  pctMove: number;
  bars: number;                 // bars-in-trade
  mae: number;                  // max adverse excursion in R
  mfe: number;                  // max favorable excursion in R
  archetype: TouchArchetype;
  entryModel: EntryModel;
  regime?: RegimeLabel;
  fold: number;
  // --- Cost-vs-risk diagnostics (added in completion-pass v2) ---
  // All fields below are reporting-only; they never feed any engine.
  rawR?: number;                          // gross R BEFORE fees / slippage
  costR?: number;                         // round-trip fee + slippage cost in R units
  netR?: number;                          // == rMultiple, exposed under semantic name
  riskDistanceBps?: number;               // stopDist / entryPrice * 10000
  targetDistanceBps?: number;             // |targetPrice - entryPrice| / entryPrice * 10000
  roundTripCostBps?: number;              // 2*feeBps + 2*slippageBps
  costToRiskRatio?: number;               // roundTripCostBps / riskDistanceBps
  minimumTradeableRiskPassed?: boolean;   // passes RunConfig.minRiskBps + maxCostToRiskRatio
}

export type TouchArchetype = "first-touch" | "retest" | "deep-wick" | "shallow-wick";
export type EntryModel = "rejection" | "reclaim" | "retest";
export type RegimeLabel = "trend-up" | "trend-down" | "range" | "high-vol" | "low-vol";

export type BenchmarkKind =
  | "random"
  | "swing-pivot"
  | "prev-day-hl"
  | "prev-week-hl"
  | "market-profile-poc"
  | "value-area"
  | "vwap-band"
  | "equal-highs-lows";

export interface FoldStat {
  fold: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  expectancyR: number;
}

export interface ProportionStat {
  k: number;          // successes
  n: number;          // total
  p: number;          // k/n
  low95: number;      // Wilson lower bound
  high95: number;     // Wilson upper bound
  label: SampleLabel;
}

export type SampleLabel = "very-low" | "low" | "moderate" | "headline";

export interface MutationSnapshot {
  takenAt: number;
  registryStats: { symbols: number; total: number };
  registryDigests: Record<string, string>;  // symbol -> hash of (id,price,strength,touches)
  // Read-only `SELECT count(*)` on every introspectable persisted table
  // (added in the hardening pass). Tables whose row count is unchanged
  // across the run contribute to the PASSED verdict; missing tables
  // contribute to PARTIAL.
  dbCounts: Record<string, number>;
  partial: boolean;
  notes: string[];
}

export interface ForwardConfig {
  runId: string;
  startedAt: number;
  symbols: string[];
  intervals: string[];
  durationMs: number;
  pollMs: number;
  tpR: number;
  slAtrMult: number;
  timeoutBars: number;
  feeBps: number;
  slippageBps: number;
  engineConfigHash: string;
  engineGitSha: string;
  validationSuiteVersion: string;
}

export interface ForwardStatus {
  runId: string;
  phase: "queued" | "running" | "done" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
  ticks: number;
  openPositions: number;
  closedTrades: number;
  reportPath?: string;
  errors: string[];
}
