// Phase 3 — Local-rollover bar logic, ported verbatim from the production
// `HeatmapChart.tsx::updateCandleStore` rollover semantics and the spike
// adapter `tvDatafeed.ts::subscribeBars`. Kept as a pure function so it
// is unit-testable without React, WebSockets, or DOM, and so the
// `HttpDatafeed.subscribeBars` implementation stays a thin wrapper.
//
// Semantics (must match production exactly):
//   • A live mark tick that lands inside the active bar's window EXTENDS
//     the bar in place: close = mark, high = max(high,mark), low =
//     min(low,mark) (low only when prior low > 0).
//   • A live mark tick that lands at or after the active bar's window end
//     OPENS a new bar anchored to the previous close. The new bar's open
//     is the previous close, high/low/close all start at the mark price.
//   • If there is no active bar yet (cold start with no seed), synthesize
//     one anchored to the floor of `now / intervalMs` with the mark price
//     in all four OHLC slots.
//   • The rollover never decreases time. A tick whose `now` is strictly
//     before `active.time` is silently dropped (defensive — this should
//     not happen but matches today's behavior).
//
// The function is pure: same inputs always produce the same outputs.

import type { Bar, Resolution } from "./types";
import { INTERVAL_MS } from "./types";

export interface RolloverResult {
  bar: Bar;
  // Whether this tick extended the existing bar (true) or rolled into a
  // new one (false). Useful for tests and for renderers that want to
  // distinguish "update last bar" from "append new bar".
  extended: boolean;
}

export function rollover(
  resolution: Resolution,
  active: Bar | null,
  markPrice: number,
  now: number,
): RolloverResult | null {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;
  const intervalMs = INTERVAL_MS[resolution];
  if (!intervalMs) return null;

  // Cold start: synthesize a bar at the current window's anchor.
  if (!active) {
    const t = Math.floor(now / intervalMs) * intervalMs;
    return {
      bar: {
        time: t,
        open: markPrice,
        high: markPrice,
        low: markPrice,
        close: markPrice,
        volume: 0,
      },
      extended: false,
    };
  }

  // Defensive: tick before active bar's start — drop.
  if (now < active.time) return null;

  const windowEnd = active.time + intervalMs;
  if (now >= windowEnd) {
    // Open a new bar anchored to the prior close. Mirrors the
    // production rollover branch in updateCandleStore.
    const newTime = Math.floor(now / intervalMs) * intervalMs;
    const anchor = active.close > 0 ? active.close : markPrice;
    return {
      bar: {
        time: newTime,
        open: anchor,
        high: Math.max(anchor, markPrice),
        low: Math.min(anchor, markPrice),
        close: markPrice,
        volume: 0,
      },
      extended: false,
    };
  }

  // Extend in place. `low > 0` guard preserves the existing-low when
  // tick is exactly equal to a zero baseline (which only happens in
  // synthesized seeds — defensive only).
  const next: Bar = {
    time: active.time,
    open: active.open,
    high: Math.max(active.high, markPrice),
    low: active.low > 0 ? Math.min(active.low, markPrice) : markPrice,
    close: markPrice,
    volume: active.volume,
  };
  return { bar: next, extended: true };
}
