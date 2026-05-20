// Slim Bookmap-style left-side DOM ladder + liquidity heatmap strip.
//
// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This component is a DISPLAY-ONLY visual order-flow context panel.
// It is NOT, and must NEVER become, part of the structural-levels
// engine or the liquidity engine. It must NEVER influence:
//   • level discovery, ranking, persistence, or decay
//   • scoring, pivots, quantile bands, confluence, presets
//   • backtest reliability or any overlay logic
//
// It is a downstream visual consumer ONLY. It reads from existing data
// streams that the rest of the app produces; it never writes back.
//
// Allowed inputs (read-only):
//   • the chart's published price-axis snapshot (chartAxisBus) so its
//     rows align EXACTLY with the chart's price grid
//   • the same `heatmap:${symbol}` WebSocket channel the chart already
//     subscribes to via useChannel (pub/sub fan-out — no extra backend
//     load, no extra socket)
//   • the chart's existing `useRegistryLevels(symbol)` hook for full-
//     range engine-discovered support/resistance levels. This is the
//     SAME public hook the chart itself consumes; we only read its
//     output, never feed anything back. Registry levels fill rows that
//     fall OUTSIDE the L2 orderbook's natural ±1–2 % depth window so
//     the panel reads as populated across the full visible price range
//     using only real engine output (no fabricated sizes).
//   • an optional cold-start REST snapshot passed in as `coldStart`
//
// Forbidden imports — engine INTERNALS (must stay forbidden):
//   • api-server / services / engines (level-generation logic itself)
//   • registry-service internals, decay logic, level-generation code
//   • scoring / confluence / precision / reliability / regime modules
//   • touch / confirmation engine
// The distinction is precise: consuming the engine's PUBLIC OUTPUT via
// the same read-only hooks the chart uses is fine and is how the panel
// stays in sync with the rest of the app. Reaching into engine source
// modules, mutating registry state, or feeding panel state back into
// any engine input is forbidden.
//
// If a future visual feature needs more context, add it as another
// READ-ONLY adapter — never wire this panel into engine inputs.
// =====================================================================
//
// PERFORMANCE
// -----------
// The component owns one canvas. It runs its own requestAnimationFrame
// loop driven by a "dirty" flag that flips when the axis snapshot
// changes OR a new orderbook delta arrives. Tick-rate updates do NOT
// cause React re-renders — both the axis subscription and the channel
// callback write to refs and mark dirty; the rAF loop redraws at frame
// rate at most. The chart's render path is entirely independent.
//
// LAYOUT
// ------
// Single canvas, ~120-130px wide (per the user's spec of 100-160px
// total). Internal columns:
//   ┌────────┬───────────────────────────────────┐
//   │ heat   │  price       │  size (intensity)  │
//   │ strip  │              │                    │
//   │ 38px   │  ~58px       │  ~36px             │
//   └────────┴───────────────────────────────────┘
// Bid rows tinted green, ask rows tinted red, current-price row
// highlighted by a horizontal accent line that spans the entire panel.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getChartAxis,
  subscribeChartAxis,
  type ChartAxisSnapshot,
} from "@/lib/chartAxisBus";
import { useChannel } from "@/hooks/useChannel";
import { useRegistryLevels, type RegistryLevel } from "@/hooks/useRegistryLevels";
import { normalizeSymbolKey } from "@/datafeed/normalize";
import type { LiquidityHeatmap } from "@workspace/api-client-react";

const PANEL_WIDTH = 130;
const HEATMAP_STRIP_W = 38;
const PRICE_COL_W = 56;
// SIZE_COL_W is the remainder.

const ROW_HEIGHT_PX = 12; // dense rows like the reference image
const FONT_PRICE = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
const FONT_SIZE = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Mirrors the api-server `HeatLevel` shape that the chart's heatmap
 * channel publishes. Each level is a single price point with separate
 * bid and ask sizes (standard orderbook representation). We only need
 * a small subset of fields here — the engine fields (heatScore,
 * compositeScore, imbalanceRatio, etc.) are deliberately ignored to
 * keep this component a pure visualisation of raw bid/ask depth.
 */
interface HeatLevelLike {
  price: number;
  bidSize: number;
  askSize: number;
}

interface DomLadderPanelProps {
  symbol: string;
  /**
   * Cold-start orderbook snapshot from REST. The chart's REST fetch
   * already runs; we accept the same payload here so we have something
   * to render on first paint before the WebSocket delta arrives.
   */
  coldStart: LiquidityHeatmap | null;
}

export function DomLadderPanel({
  symbol,
  coldStart,
}: DomLadderPanelProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Track wrapper height to size the canvas. We don't use the chart's
  // containerH from the bus directly because that's the chart canvas
  // height — the ladder is a sibling in flex and gets its own height.
  // They will match because both are stretched to the parent flex row.
  const [wrapperH, setWrapperH] = useState<number>(0);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = Math.round(entry.contentRect.height);
      setWrapperH((prev) => (prev === h ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The currently-known axis snapshot. Held in a ref so the rAF loop
  // can read it without triggering React renders on every chart tick.
  const axisRef = useRef<ChartAxisSnapshot | null>(getChartAxis());

  // Latest orderbook levels (raw, ungrouped). Held in a ref for the
  // same reason as the axis — we never want a tick to cause a React
  // re-render of the whole panel.
  const levelsRef = useRef<HeatLevelLike[]>([]);
  const markPriceFromChannelRef = useRef<number | null>(null);

  // Seed levels from the cold-start REST snapshot. Re-runs only on
  // symbol switch or when the REST payload identity changes — not on
  // every tick (the WS channel handles ticks).
  useEffect(() => {
    if (!coldStart) return;
    if (coldStart.symbol && symbol &&
        normalizeSymbolKey(coldStart.symbol) !== normalizeSymbolKey(symbol)) {
      // Stale cold-start payload from before the symbol switch.
      return;
    }
    const levels = (coldStart.levels ?? []) as unknown as HeatLevelLike[];
    if (levels.length === 0) return;
    levelsRef.current = levels;
    if (typeof coldStart.markPrice === "number" && coldStart.markPrice > 0) {
      markPriceFromChannelRef.current = coldStart.markPrice;
    }
    markDirty();
  }, [coldStart, symbol]);

  // Subscribe to the chart's axis bus. Listener fires only when the
  // snapshot meaningfully changes (deduped inside the bus).
  useEffect(() => {
    axisRef.current = getChartAxis();
    markDirty();
    return subscribeChartAxis((snap) => {
      axisRef.current = snap;
      markDirty();
    });
  }, []);

  // Subscribe to the live orderbook stream. SAME channel the chart
  // already uses; the WS layer is a multiplexed pub/sub so this does
  // NOT open a second socket or hit the backend twice — it just adds
  // a second listener on the existing channel.
  const wsSymbol = useMemo(() => normalizeSymbolKey(symbol), [symbol]);
  useChannel<Partial<LiquidityHeatmap>>(`heatmap:${wsSymbol}`, (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (Array.isArray(payload.levels)) {
      levelsRef.current = payload.levels as unknown as HeatLevelLike[];
    }
    if (typeof payload.markPrice === "number" && payload.markPrice > 0) {
      markPriceFromChannelRef.current = payload.markPrice;
    }
    markDirty();
  });

  // Reset live state on symbol switch so we don't render stale data
  // for the previous symbol while waiting for the first WS delta.
  useEffect(() => {
    levelsRef.current = [];
    markPriceFromChannelRef.current = null;
    markDirty();
  }, [wsSymbol]);

  // Full-range engine-discovered levels (support/resistance) consumed
  // via the SAME public hook the chart itself uses. These are real,
  // engine-output data — not orderbook depth — and they span the full
  // visible chart price range. We use them to fill ladder rows that
  // fall OUTSIDE the L2 orderbook's natural ±1–2 % depth window so the
  // panel reads as populated top-to-bottom with real data instead of
  // being visually empty far from the mark price. Stored in a ref so
  // the rAF draw loop can read without the panel having to re-render
  // on every chart tick — registry updates are infrequent (seconds to
  // minutes) and we explicitly re-mark dirty on change.
  const registryLevels = useRegistryLevels(symbol);
  const registryLevelsRef = useRef<RegistryLevel[]>(registryLevels);
  useEffect(() => {
    registryLevelsRef.current = registryLevels;
    markDirty();
  }, [registryLevels]);

  // ====== rAF render loop ======
  // dirtyRef + a single-flight rAF schedule. Avoids redundant draws
  // when bursts of ticks arrive within one frame.
  const dirtyRef = useRef(true);
  const rafRef = useRef<number>(0);

  function markDirty() {
    dirtyRef.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(tick);
  }

  function tick() {
    rafRef.current = 0;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    draw();
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const axis = axisRef.current;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = PANEL_WIDTH;
    const cssH = wrapperH;
    if (cssH < 20) return;

    // (Re)size canvas backing store only when needed.
    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background — match chart's deep canvas tone.
    ctx.fillStyle = "#0c0c1d";
    ctx.fillRect(0, 0, cssW, cssH);

    if (!axis) {
      // Chart hasn't published yet (still loading). Show a quiet
      // placeholder so the panel reads as "alive but waiting".
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = FONT_PRICE;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("DOM", cssW / 2, cssH / 2 - 6);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillText("…", cssW / 2, cssH / 2 + 6);
      return;
    }

    const { minPrice, maxPrice, priceAreaH, scaleMode, markPrice, priceDecimals } = axis;
    const useLog = scaleMode === "log" && minPrice > 0;
    const logMin = useLog ? Math.log(minPrice) : 0;
    const logMax = useLog ? Math.log(maxPrice) : 0;
    const logRange = useLog ? logMax - logMin : 1;
    const priceRange = maxPrice - minPrice;
    if (priceRange <= 0 || priceAreaH <= 0) return;

    // Same priceToY math the chart uses, ensuring rows line up exactly.
    const priceToY = (p: number): number => {
      if (useLog && p > 0) {
        return (1 - (Math.log(p) - logMin) / logRange) * priceAreaH;
      }
      return (1 - (p - minPrice) / priceRange) * priceAreaH;
    };
    const yToPrice = (y: number): number => {
      const t = 1 - y / priceAreaH;
      if (useLog) {
        return Math.exp(logMin + t * logRange);
      }
      return minPrice + t * priceRange;
    };

    // Build virtualized rows: one row per ROW_HEIGHT_PX inside priceAreaH.
    // We render only the rows the user actually sees.
    const rowCount = Math.max(1, Math.floor(priceAreaH / ROW_HEIGHT_PX));
    type Row = {
      yTop: number;
      yMid: number;
      pTop: number;
      pBot: number;
      bidSum: number;
      askSum: number;
    };
    const rows: Row[] = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      const yTop = i * ROW_HEIGHT_PX;
      const yBot = yTop + ROW_HEIGHT_PX;
      const yMid = yTop + ROW_HEIGHT_PX / 2;
      // Convert pixel band to price band. Note y inverts price (top=high).
      const pTop = yToPrice(yTop);
      const pBot = yToPrice(yBot);
      rows[i] = {
        yTop,
        yMid,
        pTop, // higher price (canvas top)
        pBot, // lower price  (canvas bottom)
        bidSum: 0,
        askSum: 0,
      };
    }

    // Bin levels into rows. Linear scan over the level list; level
    // counts are typically O(150) so this is essentially free. Each
    // level carries BOTH bid and ask sizes (standard book format), so
    // we add to both sums; whether the row reads as bid- or ask-tinted
    // is decided later relative to the live mark price.
    let maxIntensity = 0;
    const lvls = levelsRef.current;
    const priceLo = Math.min(minPrice, maxPrice);
    const priceHi = Math.max(minPrice, maxPrice);
    for (let i = 0; i < lvls.length; i++) {
      const lv = lvls[i]!;
      if (!Number.isFinite(lv.price)) continue;
      if (lv.price < priceLo || lv.price > priceHi) continue;
      const y = priceToY(lv.price);
      const idx = Math.floor(y / ROW_HEIGHT_PX);
      if (idx < 0 || idx >= rowCount) continue;
      const row = rows[idx]!;
      const bid = Number.isFinite(lv.bidSize) ? lv.bidSize : 0;
      const ask = Number.isFinite(lv.askSize) ? lv.askSize : 0;
      row.bidSum += bid;
      row.askSum += ask;
      const total = row.bidSum + row.askSum;
      if (total > maxIntensity) maxIntensity = total;
    }
    if (maxIntensity <= 0) maxIntensity = 1;

    // Second-pass binning: registry-discovered support/resistance
    // levels. These are real engine output (the same data driving the
    // chart's horizontal level lines) and they cover the FULL visible
    // price range — not just the L2 orderbook's ±1–2 % window. For
    // every row that received zero L2 depth we record the strongest
    // registry level whose price falls inside that row's price band,
    // if any. Rows that have real L2 depth always win — we never let
    // engine-derived data overwrite live orderbook depth. Rows with
    // neither L2 nor registry data stay genuinely blank, exactly as
    // the spec requires ("no blank rows unless there is genuinely no
    // data for that price area").
    const reg = registryLevelsRef.current;
    const regByRow: (RegistryLevel | null)[] = new Array(rowCount).fill(null);
    if (reg.length > 0) {
      for (let i = 0; i < reg.length; i++) {
        const lv = reg[i]!;
        if (!lv || !Number.isFinite(lv.price)) continue;
        if (lv.price < priceLo || lv.price > priceHi) continue;
        const y = priceToY(lv.price);
        const idx = Math.floor(y / ROW_HEIGHT_PX);
        if (idx < 0 || idx >= rowCount) continue;
        const row = rows[idx]!;
        // L2 orderbook always wins — registry only fills empty rows.
        if (row.bidSum + row.askSum > 0) continue;
        const cur = regByRow[idx];
        const lvStrength = Number.isFinite(lv.strength) ? lv.strength : 0;
        const curStrength = cur && Number.isFinite(cur.strength) ? cur.strength : -1;
        if (!cur || lvStrength > curStrength) {
          regByRow[idx] = lv;
        }
      }
    }

    // Live mark price — prefer axis (which the chart is rendering),
    // fall back to the channel's most recent value.
    const livePrice =
      typeof markPrice === "number" && Number.isFinite(markPrice) && markPrice > 0
        ? markPrice
        : markPriceFromChannelRef.current;

    // ===== Draw heatmap strip =====
    // Orderbook depth is heavily power-law distributed: a single big
    // wall can be 100× the median row. Linear scaling makes everything
    // except the wall invisible. Log-scale (relative to maxIntensity)
    // compresses the dynamic range so the eye can read both the peak
    // and the surrounding context — the same trick the chart's main
    // heatmap pane uses internally.
    const stripX = 0;
    const stripW = HEATMAP_STRIP_W;
    const intensityLogMax = Math.log1p(maxIntensity);
    for (let i = 0; i < rowCount; i++) {
      const r = rows[i]!;
      const total = r.bidSum + r.askSum;
      if (total > 0) {
        // 0..1 with log compression. Even very small rows clear ~0.3.
        const intensity =
          intensityLogMax > 0 ? Math.log1p(total) / intensityLogMax : 0;
        const isBidSide =
          livePrice != null
            ? r.yMid >= priceToY(livePrice)
            : r.bidSum >= r.askSum;
        // Brighter = more liquidity. Range 0.30 → 0.92 keeps even tiny
        // rows readable while letting walls pop. Cap below 1.0 so the
        // strip never fully obscures itself.
        const alpha = 0.30 + 0.62 * intensity;
        ctx.fillStyle = isBidSide
          ? `rgba(34, 197, 94, ${alpha.toFixed(3)})` // emerald-500
          : `rgba(239, 68, 68, ${alpha.toFixed(3)})`; // red-500
        ctx.fillRect(stripX, r.yTop, stripW, ROW_HEIGHT_PX);
      } else {
        // No L2 depth here — fall back to a registry-discovered level
        // if one exists in this row's price band. Strength-driven
        // alpha (0.18 → 0.55) is intentionally below the L2 range so
        // discovered-level cells read as visually secondary to live
        // orderbook depth. Side comes from the engine's classification
        // (support → green, resistance → red), which is more accurate
        // than a pure mark-relative split when price has recently
        // pierced a level.
        const lv = regByRow[i];
        if (!lv) continue;
        const strength = Math.max(
          0,
          Math.min(1, Number.isFinite(lv.strength) ? lv.strength : 0),
        );
        const stripAlpha = 0.18 + 0.37 * strength;
        const isBidSide = lv.side === "support";
        ctx.fillStyle = isBidSide
          ? `rgba(34, 197, 94, ${stripAlpha.toFixed(3)})`
          : `rgba(239, 68, 68, ${stripAlpha.toFixed(3)})`;
        ctx.fillRect(stripX, r.yTop, stripW, ROW_HEIGHT_PX);
      }
    }

    // Subtle separator between heatmap and ladder.
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(HEATMAP_STRIP_W, 0, 1, Math.min(priceAreaH, cssH));

    // ===== Draw ladder rows (price + size) =====
    const ladderX0 = HEATMAP_STRIP_W + 1;
    const ladderW = cssW - ladderX0;
    const priceRightX = ladderX0 + PRICE_COL_W - 6;
    const sizeRightX = cssW - 4;

    ctx.textBaseline = "middle";
    for (let i = 0; i < rowCount; i++) {
      const r = rows[i]!;
      const total = r.bidSum + r.askSum;
      const regLv = total > 0 ? null : regByRow[i];

      // Side classification: real L2 rows pivot on the live mark
      // price; registry-only rows use the engine's own support/
      // resistance assignment (more accurate when price has recently
      // pierced a level).
      const isBidSide = total > 0
        ? (livePrice != null
            ? r.yMid >= priceToY(livePrice)
            : r.bidSum >= r.askSum)
        : regLv
          ? regLv.side === "support"
          : false;

      // Faint row tint by side; deeper where intensity is higher.
      if (total > 0) {
        const intensity = total / maxIntensity;
        const tintAlpha = 0.04 + 0.18 * Math.pow(intensity, 0.7);
        ctx.fillStyle = isBidSide
          ? `rgba(34, 197, 94, ${tintAlpha.toFixed(3)})`
          : `rgba(239, 68, 68, ${tintAlpha.toFixed(3)})`;
        ctx.fillRect(ladderX0, r.yTop, ladderW, ROW_HEIGHT_PX);
      } else if (regLv) {
        const strength = Math.max(
          0,
          Math.min(1, Number.isFinite(regLv.strength) ? regLv.strength : 0),
        );
        const tintAlpha = 0.03 + 0.10 * strength;
        ctx.fillStyle = isBidSide
          ? `rgba(34, 197, 94, ${tintAlpha.toFixed(3)})`
          : `rgba(239, 68, 68, ${tintAlpha.toFixed(3)})`;
        ctx.fillRect(ladderX0, r.yTop, ladderW, ROW_HEIGHT_PX);
      }

      // Price text — represent the row by its midpoint price for
      // stable display as the axis pans. Three brightness tiers so
      // the eye can tell at a glance which rows have which kind of
      // real data: bright = live L2 depth, medium = engine-discovered
      // level, dim = no data in this band (genuinely empty).
      const pMid = (r.pTop + r.pBot) / 2;
      ctx.font = FONT_PRICE;
      ctx.textAlign = "right";
      ctx.fillStyle =
        total > 0
          ? "rgba(229,231,235,0.92)"
          : regLv
            ? "rgba(229,231,235,0.70)"
            : "rgba(229,231,235,0.40)";
      ctx.fillText(formatPrice(pMid, priceDecimals), priceRightX, r.yMid);

      // Size column.
      if (total > 0) {
        // Real orderbook depth — show as a number.
        ctx.font = FONT_SIZE;
        ctx.textAlign = "right";
        ctx.fillStyle = isBidSide ? "rgba(74, 222, 128, 0.95)" : "rgba(248, 113, 113, 0.95)";
        ctx.fillText(formatSize(total), sizeRightX, r.yMid);
      } else if (regLv) {
        // Engine-discovered level — show as an `L<tier>` badge in the
        // side colour. Deliberately non-numeric so the eye never
        // confuses an engine-derived strength with a real bid/ask
        // size in base units.
        ctx.font = FONT_SIZE;
        ctx.textAlign = "right";
        const strength = Math.max(
          0,
          Math.min(1, Number.isFinite(regLv.strength) ? regLv.strength : 0),
        );
        const tier = Math.max(1, Math.min(3, Number.isFinite(regLv.tier) ? regLv.tier : 1));
        const labelAlpha = 0.55 + 0.40 * strength;
        ctx.fillStyle = isBidSide
          ? `rgba(74, 222, 128, ${labelAlpha.toFixed(3)})`
          : `rgba(248, 113, 113, ${labelAlpha.toFixed(3)})`;
        ctx.fillText(`L${tier}`, sizeRightX, r.yMid);
      }
    }

    // ===== Current price row highlight =====
    if (livePrice != null) {
      const yLive = priceToY(livePrice);
      if (yLive >= 0 && yLive <= priceAreaH) {
        // Horizontal accent line across the entire panel.
        ctx.fillStyle = "rgba(45, 212, 191, 0.85)"; // teal-400
        ctx.fillRect(0, Math.round(yLive) - 0.5, cssW, 1);
        // Price chip on the right edge of the ladder.
        const chipText = formatPrice(livePrice, priceDecimals);
        ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        const padX = 4;
        const textW = ctx.measureText(chipText).width;
        const chipW = textW + padX * 2;
        const chipH = 12;
        const chipX = cssW - chipW;
        const chipY = Math.max(0, Math.min(priceAreaH - chipH, yLive - chipH / 2));
        ctx.fillStyle = "rgba(13, 148, 136, 0.95)"; // teal-700
        ctx.fillRect(chipX, chipY, chipW, chipH);
        ctx.fillStyle = "#0b1220";
        ctx.fillText(chipText, cssW - padX, chipY + chipH / 2);
      }
    }

    // Sub-pane area below priceAreaH stays empty (matches chart's
    // sub-pane region so rows don't appear to extend into RSI/volume).
    if (priceAreaH < cssH) {
      ctx.fillStyle = "#0c0c1d";
      ctx.fillRect(0, priceAreaH, cssW, cssH - priceAreaH);
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(0, priceAreaH, cssW, 1);
    }
  }

  // Redraw whenever wrapper height changes.
  useEffect(() => {
    markDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapperH]);

  // Clean up rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="hidden md:flex shrink-0 border-r border-border bg-card relative"
      style={{ width: PANEL_WIDTH, minWidth: PANEL_WIDTH }}
      data-testid="dom-ladder-panel"
      aria-label="DOM ladder and liquidity heatmap"
    >
      <canvas
        ref={canvasRef}
        className="block"
        style={{ width: PANEL_WIDTH, height: "100%" }}
      />
    </div>
  );
}

// ---------- formatters ----------

function formatPrice(p: number, decimals: number): string {
  if (!Number.isFinite(p)) return "—";
  // Compact thousands separators: "77,440.12"
  return p.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSize(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(1)}M`;
  if (s >= 1_000) return `${(s / 1_000).toFixed(1)}K`;
  if (s >= 100) return s.toFixed(0);
  if (s >= 10) return s.toFixed(1);
  return s.toFixed(2);
}
