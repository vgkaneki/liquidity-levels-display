const fs = require('fs');

function patch(file, fn) {
  let src = fs.readFileSync(file, 'utf8');
  const next = fn(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[levels-request-resilience-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[levels-request-resilience-patch] skipped ${label}`);
    return src;
  }
  console.log(`[levels-request-resilience-patch] applied ${label}`);
  return src.replace(find, replace);
}

// levelsRequestResilienceV1:
// Reduce /api/levels 502 storms during rapid timeframe switching by treating
// active-chart level requests as foreground, slowing structural polling, and
// returning a pending skeleton instead of a hard 502 when no last-good exists.
// Route/transport behavior only; protected engines/formulas/scoring untouched.

patch('artifacts/liquidity-heatmap/src/lib/structuralLevels.ts', (src) => {
  src = apply(
    src,
    '    pollMs = 60_000,',
    '    pollMs = 120_000,',
    'pollMs = 120_000',
    'slower structural polling default',
  );

  src = apply(
    src,
`    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
    });`,
`    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
      // levelsRequestResilienceV1: active chart structural-zone requests are
      // foreground UX. This lets the server route schedule them ahead of
      // scanner/background work without changing engine output.
      headers: {
        "x-fetch-priority": "high",
        "x-foreground-chart": "1",
      },
    });`,
    'levelsRequestResilienceV1',
    'foreground headers for structural levels',
  );

  return src;
});

patch('artifacts/api-server/src/routes/levels.ts', (src) => {
  src = apply(
    src,
`    req.log.error(
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
    res.status(502).json({ error: "Failed to compute levels" });`,
`    // levelsRequestResilienceV1: for active-chart requests with no last-good,
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
    res.status(502).json({ error: "Failed to compute levels" });`,
    'levelsRequestResilienceV1',
    'pending skeleton instead of chart 502',
  );

  return src;
});

console.log('[levels-request-resilience-patch] complete');
