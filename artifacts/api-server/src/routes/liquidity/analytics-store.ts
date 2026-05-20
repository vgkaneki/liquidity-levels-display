// Per-symbol rolling samples that power the analytics-overlay endpoints
// (funding-rate divergence, OI delta strip, taker-pressure ribbon, real CVD).
//
// A single 5-second sampler walks the WS-fed okxStore/hlStore and the
// trades-store to produce per-bucket snapshots. Samples are kept as bounded
// ring buffers (default 720 buckets = 1 hour at 5s, plenty for the chart).
//
// All series are derived from the same WS feeds the heatmap already uses,
// so no extra REST calls are needed and the overlays update at the same
// cadence as the rest of the chart.

import { okxStore, hlStore, listActive } from "./exchanges/ws-store";
import { getRecentTrades, subscribeTradeUpdates, type TradeLite } from "./exchanges/trades-store";
import { logger } from "../../lib/logger";

const SAMPLE_INTERVAL_MS = Math.max(5_000, Number(process.env.ANALYTICS_SAMPLE_INTERVAL_MS ?? "15000") || 15_000);
const MAX_SAMPLES = 720;
const ANALYTICS_DEMAND_TTL_MS = Math.max(30_000, Number(process.env.ANALYTICS_DEMAND_TTL_MS ?? "120000") || 120_000);
const analyticsDemand = new Map<string, number>();

export interface AnalyticsSample {
  ts: number;
  fundingRate: number | null; // 8h-funding rate as decimal (e.g. 0.0001 = 1bp)
  oi: number | null;          // open interest in base units
  oiUsd: number | null;
  takerBuyUsd: number;        // bucket window (5s) taker buy notional
  takerSellUsd: number;       // bucket window taker sell notional
  cvdNotional: number;        // cumulative since boot (taker buy − sell, USD)
}

interface SymbolState {
  samples: AnalyticsSample[];
  // Canonical, bucket-derived running sum of taker buy − sell USD. Only the
  // 5s sampler advances this so the plotted CVD line is monotonic and never
  // double-counts the trade subscriber.
  bucketCvdNotional: number;
  // Live delta that has accumulated *since* the last bucket snapshot. Used
  // only to compose `latestNotional` between snapshots so the sub-pane
  // doesn't visibly step every 5s.
  liveDeltaSinceSnapshot: number;
}

const states = new Map<string, SymbolState>();

function markAnalyticsDemand(symbol: string): void {
  analyticsDemand.set(symbol, Date.now());
}

function demandedSymbols(now: number): string[] {
  const out: string[] = [];
  for (const [symbol, ts] of analyticsDemand) {
    if (now - ts <= ANALYTICS_DEMAND_TTL_MS) out.push(symbol);
    else analyticsDemand.delete(symbol);
  }
  return out;
}

function getState(symbol: string): SymbolState {
  let s = states.get(symbol);
  if (!s) {
    s = { samples: [], bucketCvdNotional: 0, liveDeltaSinceSnapshot: 0 };
    states.set(symbol, s);
  }
  return s;
}

// Walk trades inside [windowStart, windowEnd] and aggregate notional by side.
function aggregateTakerWindow(symbol: string, windowMs: number): { buyUsd: number; sellUsd: number } {
  const trades = getRecentTrades(symbol, windowMs);
  let buyUsd = 0;
  let sellUsd = 0;
  for (const t of trades as TradeLite[]) {
    const px = parseFloat(t.px);
    const sz = parseFloat(t.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    const notional = px * sz;
    if (t.side === "B") buyUsd += notional;
    else sellUsd += notional;
  }
  return { buyUsd, sellUsd };
}

function snapshotSymbol(symbol: string, now: number): void {
  const state = getState(symbol);

  // Funding: prefer OKX (8h epoch funding), fall back to HL (continuous).
  let fundingRate: number | null = null;
  const okxFunding = okxStore.getFunding(symbol);
  if (okxFunding && Number.isFinite(okxFunding.fundingRate)) {
    fundingRate = okxFunding.fundingRate;
  } else {
    const hl = hlStore.getAsset(symbol);
    if (hl && Number.isFinite(hl.funding)) fundingRate = hl.funding;
  }

  // OI: prefer OKX (already in USD), fall back to HL (base × markPx).
  let oi: number | null = null;
  let oiUsd: number | null = null;
  const okxOI = okxStore.getOI(symbol);
  if (okxOI) {
    oi = Number.isFinite(okxOI.oi) ? okxOI.oi : null;
    oiUsd = Number.isFinite(okxOI.oiUsd) ? okxOI.oiUsd : null;
  } else {
    const hl = hlStore.getAsset(symbol);
    if (hl && Number.isFinite(hl.openInterest)) {
      oi = hl.openInterest;
      const px = Number.isFinite(hl.markPx) ? hl.markPx : null;
      oiUsd = px !== null ? hl.openInterest * px : null;
    }
  }

  // Taker pressure: aggregate over the just-closed bucket window. The bucket
  // accumulator is the single source of truth for the plotted CVD series.
  const { buyUsd, sellUsd } = aggregateTakerWindow(symbol, SAMPLE_INTERVAL_MS);
  state.bucketCvdNotional += buyUsd - sellUsd;
  // Reset the live delta now that the bucket snapshot has captured this
  // window — anything that arrives after this snapshot starts a new tail.
  state.liveDeltaSinceSnapshot = 0;

  state.samples.push({
    ts: now,
    fundingRate,
    oi,
    oiUsd,
    takerBuyUsd: buyUsd,
    takerSellUsd: sellUsd,
    cvdNotional: state.bucketCvdNotional,
  });
  if (state.samples.length > MAX_SAMPLES) state.samples.shift();
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startAnalyticsSampler(): void {
  if (started) return;
  started = true;
  // Live trade subscriber feeds *only* `liveDeltaSinceSnapshot` so the
  // bucket-based CVD series stays canonical (no double counting). The live
  // delta is added on top of the bucket total when we serve `latestNotional`.
  subscribeTradeUpdates((symbol, trades) => {
    if (!trades.length) return;
    const state = getState(symbol);
    let delta = 0;
    for (const t of trades) {
      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      delta += (t.side === "B" ? 1 : -1) * px * sz;
    }
    state.liveDeltaSinceSnapshot += delta;
  });
  timer = setInterval(() => {
    const now = Date.now();
    const symbols = demandedSymbols(now);
    if (symbols.length === 0) return;
    for (const s of symbols) {
      try {
        snapshotSymbol(s, now);
      } catch (err) {
        logger.warn({ symbol: s, err: String(err) }, "analytics-store: snapshot failed");
      }
    }
  }, SAMPLE_INTERVAL_MS);
  logger.info({ intervalMs: SAMPLE_INTERVAL_MS, max: MAX_SAMPLES }, "analytics-store: sampler started");
}

export function stopAnalyticsSampler(): void {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}

// Mean & stddev over the funding history. Used to compute the rolling z-score
// the divergence strip colors. Robust to small samples (returns null std).
function meanStd(vals: number[]): { mean: number; std: number | null } {
  if (vals.length === 0) return { mean: 0, std: null };
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  if (vals.length < 4) return { mean, std: null };
  let sq = 0;
  for (const v of vals) { const d = v - mean; sq += d * d; }
  return { mean, std: Math.sqrt(sq / vals.length) };
}

export interface AnalyticsResponse {
  symbol: string;
  windowMs: number;
  funding: {
    current: number | null;
    mean: number | null;
    zScore: number | null;        // (current − mean) / std
    samples: { t: number; rate: number }[];
  };
  oiDelta: {
    current: number | null;       // latest oi (base)
    currentUsd: number | null;
    samples: { t: number; oi: number; oiUsd: number; deltaBps: number | null }[];
  };
  takerPressure: {
    currentRatio: number | null;  // (buy − sell) / (buy + sell), -1..+1
    samples: { t: number; ratio: number; buyUsd: number; sellUsd: number }[];
  };
  cvd: {
    latestNotional: number;       // cumulative USD since boot
    samples: { t: number; cvdNotional: number }[];
  };
  generatedAt: string;
}

export function getAnalytics(symbol: string, windowMs: number): AnalyticsResponse {
  markAnalyticsDemand(symbol);
  const state = states.get(symbol);
  const cutoff = Date.now() - windowMs;
  const samples = state ? state.samples.filter((s) => s.ts >= cutoff) : [];

  // Funding
  const fundingNonNull = samples
    .filter((s): s is AnalyticsSample & { fundingRate: number } => s.fundingRate !== null);
  const fundingVals = fundingNonNull.map((s) => s.fundingRate);
  const { mean, std } = meanStd(fundingVals);
  const current = fundingVals.length > 0 ? fundingVals[fundingVals.length - 1]! : null;
  const zScore = current !== null && std !== null && std > 0 ? (current - mean) / std : null;

  // OI
  const oiNonNull = samples.filter((s): s is AnalyticsSample & { oi: number } => s.oi !== null);
  const oiSamples = oiNonNull.map((s, i) => {
    const prev = i > 0 ? oiNonNull[i - 1]!.oi : null;
    const deltaBps = prev !== null && prev > 0 ? ((s.oi - prev) / prev) * 10_000 : null;
    return { t: s.ts, oi: s.oi, oiUsd: s.oiUsd ?? 0, deltaBps };
  });
  const latestOi = oiNonNull.length > 0 ? oiNonNull[oiNonNull.length - 1]!.oi : null;
  const latestOiUsd = oiNonNull.length > 0 ? oiNonNull[oiNonNull.length - 1]!.oiUsd : null;

  // Taker pressure
  const takerSamples = samples.map((s) => {
    const total = s.takerBuyUsd + s.takerSellUsd;
    const ratio = total > 0 ? (s.takerBuyUsd - s.takerSellUsd) / total : 0;
    return { t: s.ts, ratio, buyUsd: s.takerBuyUsd, sellUsd: s.takerSellUsd };
  });
  const currentRatio = takerSamples.length > 0 ? takerSamples[takerSamples.length - 1]!.ratio : null;

  // CVD: bucket samples are canonical; the live delta is composed only into
  // the latest readout so the sub-pane updates smoothly between buckets.
  const cvdSamples = samples.map((s) => ({ t: s.ts, cvdNotional: s.cvdNotional }));
  const latestNotional = state
    ? state.bucketCvdNotional + state.liveDeltaSinceSnapshot
    : 0;

  return {
    symbol,
    windowMs,
    funding: { current, mean: fundingVals.length > 0 ? mean : null, zScore, samples: fundingNonNull.map((s) => ({ t: s.ts, rate: s.fundingRate })) },
    oiDelta: { current: latestOi, currentUsd: latestOiUsd, samples: oiSamples },
    takerPressure: { currentRatio, samples: takerSamples },
    cvd: { latestNotional, samples: cvdSamples },
    generatedAt: new Date().toISOString(),
  };
}

export function analyticsStoreStats() {
  let totalSamples = 0;
  for (const s of states.values()) totalSamples += s.samples.length;
  return { symbols: states.size, totalSamples, sampleIntervalMs: SAMPLE_INTERVAL_MS };
}
