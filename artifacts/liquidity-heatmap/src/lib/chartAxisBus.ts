// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This module is a one-way READ-ONLY adapter from the main chart to the
// DOM-ladder / mini-heatmap visual panel. It is NOT part of the
// structural-levels engine, NOT part of the liquidity engine, NOT part
// of scoring / pivots / quantile bands / confluence / presets, and NOT
// part of any overlay logic that influences level discovery, ranking,
// or persistence.
//
// Allowed usage:
//   * The main chart calls publishChartAxis(...) once per render to
//     describe its current vertical price scale.
//   * The DOM ladder (and only the DOM ladder) subscribes via
//     subscribeChartAxis(...) for visual alignment.
//
// Forbidden usage (do not add):
//   * Reading this snapshot inside any engine, scorer, registry,
//     confluence merger, preset evaluator, or backtester.
//   * Writing back to the chart from a subscriber.
//   * Coupling level discovery / ranking decisions to anything the
//     ladder does. The ladder is a downstream visual consumer only.
//
// If a future feature needs price-axis context, derive it from the
// engine's own inputs — never from this bus.
// =====================================================================
//
// Tiny imperative pub/sub for the main chart's current price-axis state.
//
// Why this exists:
//   The DOM-ladder / mini-heatmap panel needs to render its rows aligned
//   with the chart's price scale (same minPrice / maxPrice / priceAreaH /
//   linear-vs-log mapping) so prices line up exactly across the two
//   surfaces. The chart recomputes its axis on every redraw — including
//   on every mark-price tick which can fire 5-10× per second — so a
//   prop-drilled or React-state-based publication channel would force
//   the ladder to re-render at tick rate, defeating the entire point
//   of decoupling these two surfaces.
//
//   This module exposes a snapshot the chart writes to imperatively,
//   plus a tiny subscriber API the ladder uses to schedule its own
//   requestAnimationFrame redraw when something meaningful changed.
//   The ladder does NOT use React state for axis updates — it reads
//   the snapshot from inside its rAF loop. Result: chart redraws and
//   ladder redraws are independent, both run at frame rate, neither
//   causes React reconciliation in the other.
//
// Engine guardrail:
//   This module is display/UI infrastructure only. It does not import
//   anything from api-server, services/engines, or registry/decay
//   modules. The chart's draw effect computes minPrice/maxPrice/etc.
//   exactly as it always has — this bus is a pure read-out of values
//   the chart already produces internally.

export interface ChartAxisSnapshot {
  /** Symbol the chart is currently rendering. */
  symbol: string;
  /** Minimum price in the visible window (after vertical zoom + margins). */
  minPrice: number;
  /** Maximum price in the visible window (after vertical zoom + margins). */
  maxPrice: number;
  /**
   * Pixel height of the chart's price-drawing area, measured from the
   * top of the chart canvas. Sub-panes (volume / RSI / indicators) sit
   * BELOW this height, so the ladder must render its rows only inside
   * `[0, priceAreaH]` to stay aligned with the chart's price grid.
   */
  priceAreaH: number;
  /**
   * Pixel height of the chart container as a whole. The ladder sizes
   * its own canvas to match so the two visually share the same vertical
   * extent (sub-pane area below the price grid stays empty in the
   * ladder, exactly mirroring the chart).
   */
  containerH: number;
  /** Linear or log price scaling. Mirrors HeatmapChart's `useLog` branch. */
  scaleMode: "linear" | "log";
  /** Latest mark price; used to highlight the current-price row. */
  markPrice: number | null;
  /**
   * Display decimals for prices in this symbol. Derived from price
   * magnitude (BTC≈2, APE≈4, sub-cent shitcoins more) so the ladder
   * formats prices the same way the chart's right-edge label does.
   */
  priceDecimals: number;
}

let current: ChartAxisSnapshot | null = null;
const listeners = new Set<(snap: ChartAxisSnapshot | null) => void>();

/**
 * Cheap structural-equality check. We avoid notifying when the axis
 * hasn't actually moved — this is important because the chart calls
 * `publishChartAxis` on EVERY redraw (every mark-price tick), and the
 * vast majority of those redraws don't shift the axis at all.
 */
function snapshotsEqual(
  a: ChartAxisSnapshot | null,
  b: ChartAxisSnapshot | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.symbol === b.symbol &&
    a.minPrice === b.minPrice &&
    a.maxPrice === b.maxPrice &&
    a.priceAreaH === b.priceAreaH &&
    a.containerH === b.containerH &&
    a.scaleMode === b.scaleMode &&
    a.markPrice === b.markPrice &&
    a.priceDecimals === b.priceDecimals
  );
}

/**
 * Publish a new axis snapshot. Called by the chart's main draw effect.
 * No-op if the snapshot is structurally identical to the current one.
 */
export function publishChartAxis(snapshot: ChartAxisSnapshot | null): void {
  if (snapshotsEqual(current, snapshot)) return;
  current = snapshot;
  for (const fn of listeners) fn(snapshot);
}

/** Read the current snapshot synchronously. Returns `null` until the chart has published once. */
export function getChartAxis(): ChartAxisSnapshot | null {
  return current;
}

/**
 * Subscribe to axis changes. The listener is called only when the
 * snapshot actually differs from the previous one (see `snapshotsEqual`).
 * Returns an unsubscribe function.
 */
export function subscribeChartAxis(
  fn: (snap: ChartAxisSnapshot | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Heuristic: how many decimal places to show for a price of this
 * magnitude. Mirrors what a typical exchange ticker shows so the
 * ladder reads naturally alongside the chart.
 */
export function decimalsForPrice(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 2;
  if (p >= 1000) return 2;
  if (p >= 100) return 2;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 6;
  return 8;
}
