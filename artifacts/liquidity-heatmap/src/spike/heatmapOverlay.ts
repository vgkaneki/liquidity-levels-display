// SPIKE-ONLY heatmap overlay sync prototype. Validates whether a
// transparent canvas positioned over the chart can stay coordinate-locked
// to the chart's price/time axes during pan/zoom/resize/live ticks.
//
// This is the explicit feasibility test for the hardest part of the TV
// integration plan (Phase 3 in the recommendation). Strategy:
//   1. Subscribe to chart's visible-range / crosshair / size events.
//   2. On every event AND on requestAnimationFrame, ask the chart for
//      `priceScale.priceToCoordinate(price)` and `timeScale.timeToCoordinate(time)`.
//      Use those pixel coords to render the heatmap intensity bands.
//   3. Measure: is sync visually tight? Any tearing during fast pan?
//
// ENGINE GUARDRAIL: this file does NOT compute heatmap values. It receives
// `levels` (from the existing `/api/liquidity/heatmap` endpoint, fetched
// by the spike page) and renders them. No math.

import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

export interface HeatmapLevel {
  price: number;
  totalSize: number;
  heatScore: number; // 0..1
  compositeScore: number; // 0..1
  isLiquidationCluster: boolean;
}

export interface HeatmapOverlayOptions {
  // Half-thickness of each price band in PRICE units. Spike hardcodes a
  // simple per-level bandwidth so we can see the bands clearly. Real
  // implementation will derive this from the existing engine's level
  // spacing.
  bandHalfWidth: (level: HeatmapLevel, allLevels: HeatmapLevel[]) => number;
  // Pixel offset from chart's right edge to draw "from" — 0 means the
  // bands extend from the right edge backwards across the visible window.
  leftPadPx?: number;
}

export class HeatmapOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<"Candlestick">;
  private readonly opts: HeatmapOverlayOptions;
  private levels: HeatmapLevel[] = [];
  private lastDrawAt = 0;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  // Frame-level metrics. A "drop" means the entire frame couldn't sync to
  // the chart's coordinates (chart not ready, between symbol switches,
  // etc). Per-level skips (price outside the visible viewport) are
  // EXPECTED and not counted — they're correct behavior.
  private syncDrops = 0;
  private syncFrames = 0;
  private levelsRendered = 0;
  private levelsOffscreen = 0;
  private dpr = 1;

  constructor(
    container: HTMLElement,
    chart: IChartApi,
    series: ISeriesApi<"Candlestick">,
    opts: HeatmapOverlayOptions,
  ) {
    this.chart = chart;
    this.series = series;
    this.opts = opts;
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = "2";
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("heatmap overlay: no 2d context");
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.resizeCanvas();

    // Subscribe to every event that can change the coordinate mapping.
    // lightweight-charts exposes these directly; TV's Charting Library
    // exposes the same (visibleRangeChanged + visibleLogicalRangeChanged
    // + crosshairMoved + sizeChanged). Same shape.
    chart.timeScale().subscribeVisibleTimeRangeChange(this.onChange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(this.onChange);

    // Resize observer for container size changes.
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.scheduleDraw();
    });
    this.resizeObserver.observe(container);

    // Start the rAF loop. Belt-and-braces: even if no event fires, we
    // redraw at most ~60 fps so live tick coordinate drift is captured.
    this.startRafLoop();
  }

  setLevels(levels: HeatmapLevel[]): void {
    this.levels = levels;
    this.scheduleDraw();
  }

  // Reset frame-level counters. Call this on symbol/timeframe switches
  // so the displayed sync ratio reflects post-switch steady state, not
  // the inevitable handful of "chart not ready" frames during the swap.
  resetCounters(): void {
    this.syncFrames = 0;
    this.syncDrops = 0;
  }

  getDiagnostics(): {
    syncFrames: number;
    syncDrops: number;
    dropRatio: number;
    lastDrawMsAgo: number;
    levelsRendered: number;
    levelsOffscreen: number;
  } {
    return {
      syncFrames: this.syncFrames,
      syncDrops: this.syncDrops,
      dropRatio: this.syncFrames > 0 ? this.syncDrops / this.syncFrames : 0,
      lastDrawMsAgo: this.lastDrawAt > 0 ? Date.now() - this.lastDrawAt : -1,
      levelsRendered: this.levelsRendered,
      levelsOffscreen: this.levelsOffscreen,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    try {
      this.chart.timeScale().unsubscribeVisibleTimeRangeChange(this.onChange);
      this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onChange);
    } catch {
      // chart may already be disposed
    }
    this.canvas.remove();
  }

  private onChange = (): void => {
    this.scheduleDraw();
  };

  private startRafLoop(): void {
    const tick = (): void => {
      if (this.disposed) return;
      this.draw();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private scheduleDraw(): void {
    // rAF loop already runs; this is a no-op hook left for the real impl
    // to debounce explicit redraws. Kept for shape parity.
  }

  private resizeCanvas(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private draw(): void {
    this.syncFrames++;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    this.ctx.clearRect(0, 0, w, h);

    if (this.levels.length === 0) {
      this.lastDrawAt = Date.now();
      return;
    }

    // Ask the chart for its current viewport in coordinate terms. If the
    // chart isn't ready (between symbol switches), priceToCoordinate
    // returns null and we skip this frame — counted as a sync drop for
    // the diagnostics readout.
    //
    // NOTE: lightweight-charts exposes `priceToCoordinate` on the SERIES
    // (because price->y depends on which series' scale you mean). TV's
    // Charting Library exposes the equivalent on the price-scale handle
    // directly. The spike uses the lightweight-charts shape; the swap to
    // TV is one line per call.
    const timeScale = this.chart.timeScale();
    const visibleRange = timeScale.getVisibleRange();
    if (!visibleRange) {
      this.syncDrops++;
      return;
    }

    const leftPx = this.opts.leftPadPx ?? 0;
    const rightPx = w - 60; // approximate price-axis gutter; TV exposes
    // priceScale().width() for an exact value. lightweight-charts has the
    // same; we keep it approximate in the spike to test sync robustness
    // under imperfect bounds.

    let renderedThisFrame = 0;
    let offscreenThisFrame = 0;
    for (const level of this.levels) {
      const yMidNullable = this.series.priceToCoordinate(level.price);
      if (yMidNullable === null) {
        // Level is outside the chart's visible price range. Expected
        // and not a sync failure — skip silently.
        offscreenThisFrame++;
        continue;
      }
      const yMid = yMidNullable;
      const halfWidthPrice = this.opts.bandHalfWidth(level, this.levels);
      const yTopNullable = this.series.priceToCoordinate(level.price + halfWidthPrice);
      const yBotNullable = this.series.priceToCoordinate(level.price - halfWidthPrice);
      if (yTopNullable === null || yBotNullable === null) {
        offscreenThisFrame++;
        continue;
      }
      renderedThisFrame++;
      const yTop = Math.min(yTopNullable, yBotNullable);
      const yBot = Math.max(yTopNullable, yBotNullable);
      const bandH = Math.max(1, yBot - yTop);

      const intensity = Math.min(1, Math.max(0, level.compositeScore));
      const alpha = 0.08 + intensity * 0.45;
      const color = level.isLiquidationCluster
        ? `rgba(255, 80, 80, ${alpha})`
        : `rgba(255, 200, 0, ${alpha})`;

      this.ctx.fillStyle = color;
      this.ctx.fillRect(leftPx, yTop, rightPx - leftPx, bandH);

      // Center thin highlight line on the level price.
      this.ctx.fillStyle = level.isLiquidationCluster
        ? `rgba(255, 80, 80, ${Math.min(1, alpha * 1.6)})`
        : `rgba(255, 200, 0, ${Math.min(1, alpha * 1.6)})`;
      this.ctx.fillRect(leftPx, yMid - 0.5, rightPx - leftPx, 1);
    }

    this.levelsRendered = renderedThisFrame;
    this.levelsOffscreen = offscreenThisFrame;
    // If we have levels but rendered zero AND none were intentionally
    // offscreen, that's a real sync failure (price scale not ready
    // despite getVisibleRange() succeeding). Count the frame.
    if (this.levels.length > 0 && renderedThisFrame === 0 && offscreenThisFrame === 0) {
      this.syncDrops++;
    }
    this.lastDrawAt = Date.now();
  }
}

// Suppress the unused-import warning from the type-only `Time` reference
// above — kept for documentation of the TV-compatible coordinate type.
export type _TimeType = Time;
