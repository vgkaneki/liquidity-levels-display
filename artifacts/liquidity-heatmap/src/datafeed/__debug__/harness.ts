// Phase 3 — IDatafeed debug harness.
//
// Calls every method on the production datafeed against the live
// backend and prints results. Intentionally NOT wired into a route or
// component — gated behind an explicit dev import so production builds
// never include it. T2 keeps this around long enough to verify the
// contract end-to-end; T3 / T4 may delete it once consumers prove the
// layer works in real flows.
//
// Usage from the browser devtools:
//
//   import("/src/datafeed/__debug__/harness.ts").then(m => m.runHarness())
//
// or in a one-off `__debug__` page that imports `runHarness` and calls
// it on mount. Either way, the harness exits cleanly: every subscription
// is unsubscribed before the function returns.

import { getHttpDatafeed } from "../HttpDatafeed";
import { rollover } from "../localRollover";
import type { Bar } from "../types";

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log("[datafeed-harness]", ...args);
};

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function assertRolloverContract(): void {
  // Sanity: extend branch.
  const seed: Bar = {
    time: 1_000_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 0,
  };
  const ext = rollover("1m", seed, 100.7, 1_000_000 + 30_000);
  if (!ext || !ext.extended) throw new Error("rollover: extend branch did not extend");
  if (ext.bar.close !== 100.7) throw new Error("rollover: extend close wrong");
  if (ext.bar.high !== 101) throw new Error("rollover: extend high preserved");

  // Sanity: rollover branch.
  const next = rollover("1m", seed, 102, 1_000_000 + 60_000);
  if (!next || next.extended) throw new Error("rollover: rollover branch did not roll");
  if (next.bar.open !== seed.close) throw new Error("rollover: anchor not prev close");
  if (next.bar.time === seed.time) throw new Error("rollover: time did not advance");

  // Sanity: cold start.
  const cold = rollover("5m", null, 200, 1_000_000);
  if (!cold) throw new Error("rollover: cold start returned null");
  if (cold.bar.open !== 200 || cold.bar.close !== 200) {
    throw new Error("rollover: cold start OHLC wrong");
  }

  log("rollover: 3/3 invariants OK");
}

export async function runHarness(symbol = "BTCUSDT"): Promise<void> {
  log("starting against", symbol);
  assertRolloverContract();

  const df = getHttpDatafeed();

  // Symbols
  const list = await withTimeout(df.listSymbols({ limit: 5 }), 8_000, "listSymbols");
  log("listSymbols total=", list.total, "first=", list.items[0]?.ui);

  const search = await withTimeout(df.searchSymbols("BTC", { limit: 3 }), 8_000, "search");
  log("searchSymbols BTC count=", search.length, "top=", search[0]?.ui);

  const one = await withTimeout(df.getSymbol(symbol), 8_000, "getSymbol");
  log("getSymbol", symbol, "→", one?.ui ?? null);

  // Server time
  const t = await withTimeout(df.serverTime(), 5_000, "serverTime");
  log("serverTime now=", t, "skewMs=", Date.now() - t);

  // Candles — limit + range
  const limited = await withTimeout(
    df.fetchCandles({ symbol, resolution: "1H", limit: 5 }),
    10_000,
    "candles limit",
  );
  log("candles limit count=", limited.bars.length, "mode=", limited.mode, "src=", limited.source);

  const now = Date.now();
  const ranged = await withTimeout(
    df.fetchCandles({ symbol, resolution: "1H", from: now - 6 * 3_600_000, to: now }),
    10_000,
    "candles range",
  );
  log("candles range count=", ranged.bars.length, "mode=", ranged.mode, "src=", ranged.source);

  // Levels (fetch only; subscription tested below)
  let levelsCount = -1;
  try {
    const levels = await withTimeout(
      df.fetchLevels({ symbol, interval: "4H" }),
      20_000,
      "levels",
    );
    levelsCount = levels.levels.length;
    log("levels count=", levelsCount, "updatedAt=", levels.updatedAt);
  } catch (e) {
    log("levels fetch failed (non-fatal):", String(e));
  }

  // Subscriptions — collect a few payloads each, then tear down.
  const subs: Array<{ name: string; sub: { unsubscribe(): void } }> = [];
  let markCount = 0;
  let barCount = 0;
  let depthCount = 0;
  let levelsDeltaCount = 0;
  let liqCount = 0;

  subs.push({
    name: "mark",
    sub: df.subscribeMark(symbol, () => { markCount++; }),
  });
  subs.push({
    name: "bars",
    sub: df.subscribeBars(
      { symbol, resolution: "1m", lastBar: limited.bars[limited.bars.length - 1] ?? null },
      () => { barCount++; },
    ),
  });
  subs.push({
    name: "depth",
    sub: df.subscribeDepth(symbol, () => { depthCount++; }),
  });
  subs.push({
    name: "levels-stream",
    sub: df.subscribeLevels(symbol, () => { levelsDeltaCount++; }),
  });
  subs.push({
    name: "liq",
    sub: df.subscribeLiquidations(
      symbol,
      (snap) => { liqCount += snap.clusters.length; },
      { intervalMs: 3_000 },
    ),
  });

  log("subscriptions live; sampling 5s…");
  await new Promise((r) => setTimeout(r, 5_000));

  for (const s of subs) s.sub.unsubscribe();
  log("teardown done. counts=", {
    mark: markCount,
    bars: barCount,
    depth: depthCount,
    levelsDelta: levelsDeltaCount,
    liqClusters: liqCount,
  });
}
