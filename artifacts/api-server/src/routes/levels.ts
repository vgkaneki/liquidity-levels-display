import { Router, type IRouter, type Request } from "express";
import { GetLevelsQueryParams } from "../schemas/levels";
import {
  getCachedLevels,
  createLevelsTimingCollector,
  runWithLevelsTimingCollector,
} from "../services/orchestrator";
import { sendCached } from "../services/cache";
import { runWithPriority, type FetchPriority, getHlPressure } from "../services/hyperliquid";
import { scheduleNormalizedLevelsRefresh } from "../services/levelsHost";
import { isSymbolListed } from "./liquidity";

// Foreground requests (active chart symbol, prefetch on hover/click) send
// `x-fetch-priority: high`; the scanner fan-out leaves it unset and runs at
// the default background priority. Queries can also opt in via `?priority=high`
// for ad-hoc/manual testing.
function priorityFromRequest(req: Request): FetchPriority {
  const header = req.get("x-fetch-priority");
  if (header && header.toLowerCase() === "high") return "high";
  const query = req.query.priority;
  if (typeof query === "string" && query.toLowerCase() === "high") return "high";
  return "normal";
}

const router: IRouter = Router();

// Server-side last-good cache for /api/levels. Independent of the
// orchestrator's TtlCache (which evicts on TTL expiry and propagates
// errors to callers): this map only ever stores responses that the
// orchestrator returned successfully, and is used purely as a fallback
// when a fresh compute fails or times out. A 502 from this route blanks
// the chart's structural-zone overlay; serving the prior successful
// payload with `stale: true` keeps the user's view stable across
// transient upstream incidents.
//
// Bounded with FIFO eviction. Keys are `${symbol}|${interval}`.
const LEVELS_LASTGOOD_MAX = 1024;
// Re-extended 2026-04-23 from 2 min → 30 min after audit telemetry
// showed real foreground /api/levels responses taking 15-49s on slow
// upstream paths. With the new SWR delivery (see handler), a recent
// last-good is served INSTANTLY and a background refresh is fired —
// so the user never waits for a slow compute as long as we have any
// last-good in the window. The previous 2 min ceiling was too tight:
// any away-and-back exceeded it for non-warmed symbols and forced a
// blank-chart wait. The frontend already surfaces a "Levels delayed"
// badge whenever `stale: true` so users can see when they're looking
// at non-fresh data; that's a better UX than a 30-second loading spinner.
const LEVELS_LASTGOOD_TTL_MS = 30 * 60 * 1000;
// Stale-while-revalidate: if we have a last-good newer than this, we
// serve it INSTANTLY and refresh in the background. This is the
// dominant fix for the audit's top finding (15-49s foreground waits).
// 45s is comfortably below the engine's intrinsic refresh cadence so
// users never see data older than one refresh cycle on warmed pairs.
const LEVELS_SWR_FRESH_MS = 45 * 1000;
// Bounded foreground compute wait. Two thresholds:
//   • SOFT (4.5s) applies when we have last-good to fall back to —
//     after this we serve last-good with `stale: true` rather than
//     making the user stare at a blank chart. The compute keeps
//     running and populates the cache for the next request, so the
//     wait is amortized.
//   • HARD (15s) applies when we have NO last-good (genuine first-
//     visit cold path). Lower than this would just convert "user
//     waits 6s for compute" into "user gets 502 → retry → still
//     waits". Higher than this and the browser starts aborting the
//     request itself. 15s is the empirical sweet spot.
const COMPUTE_TIMEOUT_SOFT_MS = 4500;
const COMPUTE_TIMEOUT_HARD_MS = 15000;
// Extension grace when the HARD cap fires WITHOUT a usable last-good
// fallback. The compute promise is still running (we attached a tail
// handler so its result lands in last-good regardless), and observed
// behavior is that under HL 429 pressure the compute very often
// finishes within a few seconds of the 15 s cap. Rather than 502 the
// foreground caller into a retry-storm, we wait one more bounded
// window for the in-flight promise to settle. Total worst-case
// foreground latency = HARD + EXTEND = 21 s, comfortably under the
// browser's default 30 s fetch budget. If the extension also expires
// we fall through to the catch path (transient → retry → 502).
const COMPUTE_TIMEOUT_EXTEND_MS = 6000;
// HL-pressure-aware short cap. When `getHlPressure().rateLimited` is
// true we KNOW upstream is in adaptive backoff (rate halved for 60 s).
// Waiting the full 15 s + 6 s extension just stretches a near-certain
// failure. Instead we cap foreground wait at 7 s and serve a "pending
// skeleton" (200 with `pending:true,stale:true,levels:[],zones:[]`)
// so the chart can render its candles immediately and badge the
// overlay as loading. The compute promise keeps running in the
// background and populates last-good for the next request — same
// amortization pattern as the other timeout branches.
const COMPUTE_TIMEOUT_PRESSURE_MS = 7000;

// Adaptive warm: every (symbol, interval) requested at least once gets
// auto-registered with `scheduleLevelsRefresh` so the second visit is a
// hot-hit even if the pair isn't on the static WARM list. Idempotent —
// `scheduleLevelsRefresh` early-returns when a handle already exists,
// so calling on every request is cheap. This collapses the cold-path
// problem for any pair the user actually opens twice.
const adaptiveWarmed = new Set<string>();
function noteForAdaptiveWarm(symbol: string, interval: string): void {
  const key = `${symbol}|${interval}`;
  if (adaptiveWarmed.has(key)) return;
  adaptiveWarmed.add(key);
  try {
    scheduleNormalizedLevelsRefresh(symbol, interval);
  } catch {
    /* warm scheduling is best-effort — never block the request */
  }
}

// Pending-skeleton response. Same shape as the `unsupported` sentinel
// returned by the orchestrator (services/orchestrator.ts:348), so the
// chart's existing handling for empty levels/zones works unchanged.
// Difference: `pending:true` (vs `unsupported:true`) tells the frontend
// "real data is coming, retry shortly" instead of "this symbol has no
// upstream data ever." Sent with `Cache-Control: no-store` so the next
// poll always re-tries the route (which by then should be a hot-hit
// from the in-flight compute we left running).
function sendPendingSkeleton(
  res: import("express").Response,
  symbol: string,
  interval: string,
  reason: string,
): void {
  res.setHeader("X-Levels-Stale", "1");
  res.setHeader("X-Levels-Pending", "1");
  res.setHeader("X-Levels-Reason", reason);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    symbol,
    interval,
    currentPrice: 0,
    regime: {
      symbol, interval, hurst: 0, regimeLabel: "unknown",
      signalWeightMultiplier: 1, garchVolatility: 0, garchRegime: "normal" as const,
    },
    levels: [],
    zones: [],
    signals: [],
    divergences: [],
    kde: [],
    liquidations: [],
    ai: undefined,
    generatedAt: Date.now(),
    pending: true,
    stale: true,
    dataSource: null,
  });
}

// Synchronous unsupported sentinel — same shape as the orchestrator's
// `unsupported: true` return (services/orchestrator.ts:348) so the chart
// renders the existing "no data for this symbol" friendly inline note.
// Used by the universe-cache fast-path to avoid a 7-21s cold compute on
// symbols that no upstream lists.
function buildUnsupportedSentinel(symbol: string, interval: string): Record<string, unknown> {
  return {
    symbol,
    interval,
    currentPrice: 0,
    regime: {
      symbol, interval, hurst: 0, regimeLabel: "unknown",
      signalWeightMultiplier: 1, garchVolatility: 0, garchRegime: "normal" as const,
    },
    levels: [],
    zones: [],
    signals: [],
    divergences: [],
    kde: [],
    liquidations: [],
    ai: undefined,
    generatedAt: Date.now(),
    unsupported: true,
    dataSource: null,
  };
}
type LevelsLastGood = { payload: unknown; cachedAt: number };
const levelsLastGood = new Map<string, LevelsLastGood>();
function rememberLevelsLastGood(key: string, payload: unknown): void {
  levelsLastGood.delete(key);
  while (levelsLastGood.size >= LEVELS_LASTGOOD_MAX) {
    const oldest = levelsLastGood.keys().next().value;
    if (oldest === undefined) break;
    levelsLastGood.delete(oldest);
  }
  levelsLastGood.set(key, { payload, cachedAt: Date.now() });
}

// Cold-cache fan-out for a never-seen symbol issues 5–6 upstream calls in
// a tight burst. Even with the in-process retry/dedupe, a foreground click
// can occasionally collide with the remaining Hyperliquid 429 budget and
// surface a 502 to the user. We absorb that residual at the route level
// with a small wait + single retry on transient upstream errors so the
// user sees a brief loading state instead of a red error.
const TRANSIENT_RETRY_DELAY_MS = 700;

function isTransientUpstreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Matches the error shape thrown by hyperliquid.ts (`Hyperliquid 429: …`,
  // `Hyperliquid 502: …`, etc.) and generic network failures.
  if (/Hyperliquid\s+(?:429|5\d\d)/.test(msg)) return true;
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) return true;
  return false;
}

// Background refresh helper used by the SWR fast path and the
// compute-timeout fallback. Runs at NORMAL priority (we already
// answered the user) and updates last-good on success. Errors are
// logged but never escalate — by definition we already served
// something to the caller.
function refreshInBackground(
  symbol: string,
  interval: string,
  reason: string,
  log: { warn: (...args: unknown[]) => void },
): void {
  const key = `${symbol}|${interval}`;
  void runWithPriority("normal", () => getCachedLevels(symbol, interval))
    .then((r) => {
      rememberLevelsLastGood(key, r.value);
    })
    .catch((err) => {
      log.warn({ err, symbol, interval, reason, outcome: "bg-refresh-fail" }, "levels bg refresh failed");
    });
}

router.get("/levels", async (req, res) => {
  const parsed = GetLevelsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { symbol, interval } = parsed.data;
  const priority = priorityFromRequest(req);
  const key = `${symbol}|${interval}`;
  // Adaptive warm-up: register this (symbol, interval) for periodic
  // background refresh so the second visit is always a hot-hit. Cheap
  // and idempotent — no-ops on repeat calls.
  noteForAdaptiveWarm(symbol, interval);

  // === SWR FAST PATH ===
  // If we have a last-good newer than LEVELS_SWR_FRESH_MS, return it
  // immediately and kick off a background refresh. This is the single
  // biggest UX improvement: a user revisiting any symbol/timeframe in
  // the last 45 s never waits on a network compute. Combined with the
  // route's serialized last-good (survives across the engine's TtlCache
  // expiry), this collapses the audit's top-10 worst paths from
  // 15-49 s of foreground wait to a sub-millisecond response.
  const swrCandidate = levelsLastGood.get(key);
  if (swrCandidate && Date.now() - swrCandidate.cachedAt < LEVELS_SWR_FRESH_MS) {
    const ageMs = Date.now() - swrCandidate.cachedAt;
    res.setHeader("X-Levels-SWR", "fresh-lastgood");
    res.setHeader("X-Levels-Age-Ms", String(ageMs));
    res.setHeader("Cache-Control", "no-store");
    res.json(swrCandidate.payload);
    req.log.info({ symbol, interval, priority, ageMs, outcome: "swr-fresh" }, "levels swr served");
    refreshInBackground(symbol, interval, "swr-fresh", req.log);
    return;
  }

  // === UNSUPPORTED-SYMBOL FAST-PATH ===
  // Before paying for a 7-21 s orchestrator compute that will end in the
  // `unsupported: true` sentinel anyway, consult the universe cache (a
  // union of OKX + HL + Toobit instrument lists, refreshed every 30 s).
  // If the cache is hot AND the symbol is not present on any exchange
  // we KNOW the compute can't produce real data — return the sentinel
  // immediately. We also remember the sentinel as last-good so the next
  // request for the same unknown symbol SWR-hits in <1 ms instead of
  // re-running this gate.
  //
  // We never serve the sentinel on a "unknown" reading (cache cold or
  // very stale) — falling through to the slow path is the correct
  // behavior in that case. False-negatives on unsupported are fine; a
  // false-positive (telling a user a real symbol is unsupported) would
  // be a worse experience.
  if (isSymbolListed(symbol) === "no") {
    const sentinel = buildUnsupportedSentinel(symbol, interval);
    rememberLevelsLastGood(key, sentinel);
    req.log.info(
      { symbol, interval, priority, outcome: "unsupported-fast-fail", source: "universe-cache" },
      "levels unsupported fast-fail (symbol not in any exchange universe)",
    );
    res.setHeader("X-Levels-Unsupported", "1");
    res.setHeader("X-Levels-Reason", "not-in-universe");
    res.setHeader("Cache-Control", "no-store");
    res.json(sentinel);
    return;
  }

  // Per-request observability wrapper — pure timing/logging, no logic
  // change. The collector is populated by orchestrator.computeLevelsData
  // on a cache miss; on a cache hit it stays zeroed and we still emit
  // one structured timing record so every /api/levels request shows up
  // in the log stream with the same shape.
  //
  // Documented edge case: a request that arrives while another request
  // for the same (symbol, interval) is mid-compute is "deduped" by
  // TtlCache onto the in-flight promise (services/cache.ts) and returns
  // `hit: true`. Its own ALS collector therefore stays at zeros — but
  // `totalMs` still reflects the real wall-time it spent waiting. So
  // `cacheHit: true` paired with a non-trivial `totalMs` (> ~25 ms)
  // signals "deduped onto an active compute", not a true memory hit.
  // This is intentional; propagating the originating compute's stage
  // timings to the waiter would require teaching TtlCache about the
  // collector shape, which is more invasive than this task warrants.
  const t0 = performance.now();
  const collector = createLevelsTimingCollector();
  try {
    // === BOUNDED FOREGROUND COMPUTE ===
    // We race the real compute against a timeout chosen by whether we
    // have a last-good fallback ready. With fallback: 4.5s soft cap +
    // serve stale. Without fallback: 15s hard cap so a genuine cold
    // first-visit still gets the chance to complete on the upstream's
    // typical worst-case latency rather than 502'ing into a retry
    // storm. The compute promise itself keeps running so its result
    // lands in the cache for the next caller — wait time is amortized,
    // not wasted.
    const TIMEOUT = Symbol("compute-timeout");
    const preLg = levelsLastGood.get(key);
    const hasFallback = !!(preLg && Date.now() - preLg.cachedAt < LEVELS_LASTGOOD_TTL_MS);
    // HL-pressure-aware timeout selection. With last-good: SOFT (4.5 s,
    // serve stale on expiry — unchanged). Without last-good and HL is
    // healthy: HARD (15 s, with extension). Without last-good and HL
    // IS in adaptive 429 backoff: PRESSURE (7 s, then serve a pending
    // skeleton so the user sees a usable chart fast instead of waiting
    // 21 s for a near-certain-to-fail compute).
    const hlPressured = !hasFallback && getHlPressure().rateLimited;
    const timeoutMs = hasFallback
      ? COMPUTE_TIMEOUT_SOFT_MS
      : hlPressured
        ? COMPUTE_TIMEOUT_PRESSURE_MS
        : COMPUTE_TIMEOUT_HARD_MS;
    let result;
    try {
      const computePromise = runWithPriority(priority, () =>
        runWithLevelsTimingCollector(collector, () => getCachedLevels(symbol, interval)),
      );
      // Attach a tail handler so a slow-but-eventual success still
      // populates last-good, even if we already responded with stale.
      computePromise
        .then((r) => rememberLevelsLastGood(key, r.value))
        .catch(() => {});
      const raced = await Promise.race([
        computePromise,
        new Promise<typeof TIMEOUT>((resolve) =>
          setTimeout(() => resolve(TIMEOUT), timeoutMs),
        ),
      ]);
      if (raced === TIMEOUT) {
        const lg = levelsLastGood.get(key);
        if (lg && Date.now() - lg.cachedAt < LEVELS_LASTGOOD_TTL_MS) {
          const ageMs = Date.now() - lg.cachedAt;
          const totalMs = Math.round(performance.now() - t0);
          req.log.warn(
            { symbol, interval, priority, totalMs, ageMs, outcome: "compute-timeout-served-stale" },
            "levels compute timed out — served last-good fallback",
          );
          res.setHeader("X-Levels-Stale", "1");
          res.setHeader("X-Levels-Reason", "compute-timeout");
          res.setHeader("X-Levels-Age-Ms", String(ageMs));
          res.setHeader("Cache-Control", "no-store");
          const payload = lg.payload as Record<string, unknown>;
          res.json({ ...payload, stale: true });
          return;
        }
        // No last-good. Two sub-cases:
        //
        //  (a) HL is in adaptive 429 backoff (`hlPressured`). Waiting
        //      another 6 s on a compute that's blocked behind HL's
        //      throttled bucket is high-cost and low-reward. Serve a
        //      pending skeleton (200, levels:[]) so the chart can paint
        //      its candle wicks immediately and badge the overlay as
        //      loading. Compute keeps running and populates last-good
        //      for the next poll — typical cadence is 30 s on the
        //      frontend, by which point the cooldown has lifted.
        //  (b) HL is healthy. Use the 6 s extension to give the near-
        //      complete compute a chance to land before 502'ing.
        if (hlPressured) {
          const totalMs = Math.round(performance.now() - t0);
          req.log.warn(
            { symbol, interval, priority, totalMs, outcome: "pressure-skeleton-served" },
            "levels short-cap fired under HL pressure — served pending skeleton",
          );
          sendPendingSkeleton(res, symbol, interval, "hl-pressure");
          return;
        }
        const EXTEND_TIMEOUT = Symbol("compute-extend-timeout");
        req.log.warn(
          { symbol, interval, priority, hardMs: COMPUTE_TIMEOUT_HARD_MS, extendMs: COMPUTE_TIMEOUT_EXTEND_MS, outcome: "compute-extend-wait" },
          "levels HARD timeout with no last-good — extending wait on in-flight compute",
        );
        const extended = await Promise.race([
          computePromise.catch((e) => ({ __extError: e } as const)),
          new Promise<typeof EXTEND_TIMEOUT>((resolve) =>
            setTimeout(() => resolve(EXTEND_TIMEOUT), COMPUTE_TIMEOUT_EXTEND_MS),
          ),
        ]);
        if (extended === EXTEND_TIMEOUT) {
          // Marked as transient so the outer catch's retry ladder can
          // kick in once. Distinct message keeps logs grep-able.
          throw new Error("Hyperliquid 502: compute-extend-no-lastgood");
        }
        if (extended && typeof extended === "object" && "__extError" in extended) {
          throw extended.__extError;
        }
        const totalMs = Math.round(performance.now() - t0);
        req.log.info(
          { symbol, interval, priority, totalMs, outcome: "compute-extend-success" },
          "levels in-flight compute completed during extension window",
        );
        result = extended;
      } else {
        result = raced;
      }
    } catch (err) {
      if (!isTransientUpstreamError(err)) throw err;
      req.log.warn({ err, symbol, interval, priority, outcome: "first-attempt-transient" }, "levels transient upstream — retrying once");
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      try {
        result = await runWithPriority(priority, () =>
          runWithLevelsTimingCollector(collector, () => getCachedLevels(symbol, interval)),
        );
        req.log.info({ symbol, interval, priority, outcome: "retry-success" }, "levels recovered after transient retry");
      } catch (retryErr) {
        req.log.error({ err: retryErr, symbol, interval, priority, outcome: "retry-fail" }, "levels still failing after transient retry");
        throw retryErr;
      }
    }
    const totalMs = Math.round(performance.now() - t0);
    // Single per-request timing line. Stage fields are 0 on cache hit
    // (collector untouched) and populated on cache miss. peers/higherTf
    // are included so a future regression investigator can see whether
    // the symbol had cross-asset peers attached.
    req.log.info(
      {
        symbol,
        interval,
        priority,
        cacheHit: result.hit,
        totalMs,
        upstreamMs: collector.upstreamMs ?? 0,
        htfPeerMs: collector.htfPeerMs ?? 0,
        engineMs: collector.engineMs ?? 0,
        computeMs: collector.computeMs ?? 0,
        peers: collector.peers,
        higherTf: collector.higherTf,
      },
      "levels timing",
    );
    // Remember every successful response as the per-(symbol,interval)
    // last-good snapshot. Used by the catch path below to serve a
    // stale-but-real response when a future compute fails.
    rememberLevelsLastGood(`${symbol}|${interval}`, result.value);
    sendCached(res, req, result, 30);
  } catch (err) {
    const totalMs = Math.round(performance.now() - t0);
    const lastGood = levelsLastGood.get(`${symbol}|${interval}`);
    if (
      lastGood &&
      Date.now() - lastGood.cachedAt < LEVELS_LASTGOOD_TTL_MS
    ) {
      // Serve the prior successful payload rather than 502ing — the
      // chart overlay stays stable through transient upstream incidents.
      // Marked with `stale: true` and a `X-Levels-Stale` header so any
      // future status surface can show "Levels delayed".
      req.log.warn(
        {
          err,
          symbol,
          interval,
          priority,
          totalMs,
          ageMs: Date.now() - lastGood.cachedAt,
          outcome: "served-stale-last-good",
        },
        "levels compute failed — served last-good fallback",
      );
      res.setHeader("X-Levels-Stale", "1");
      res.setHeader("Cache-Control", "no-store");
      const payload = lastGood.payload as Record<string, unknown>;
      res.json({ ...payload, stale: true });
      return;
    }
    // levelsRequestResilienceV1: for active-chart requests with no last-good,
    // do not 502 into a frontend retry storm. Return a pending skeleton so the
    // candle chart remains usable while the in-flight/background compute warms
    // the cache. This is route resilience only; protected engine math is not
    // changed and no fallback level is fabricated.
    if (priority === "high" || getHlPressure().rateLimited) {
      req.log.warn(
        {
          err,
          symbol,
          interval,
          priority,
          totalMs,
          upstreamMs: collector.upstreamMs,
          htfPeerMs: collector.htfPeerMs,
          engineMs: collector.engineMs,
          computeMs: collector.computeMs,
          outcome: "pending-skeleton-no-lastgood",
        },
        "levels failed — served pending skeleton instead of 502",
      );
      sendPendingSkeleton(res, symbol, interval, "compute-failed-no-lastgood");
      return;
    }
    req.log.error(
      {
        err,
        symbol,
        interval,
        priority,
        totalMs,
        upstreamMs: collector.upstreamMs,
        htfPeerMs: collector.htfPeerMs,
        engineMs: collector.engineMs,
        computeMs: collector.computeMs,
      },
      "levels failed",
    );
    res.status(502).json({ error: "Failed to compute levels" });
  }
});

export default router;
