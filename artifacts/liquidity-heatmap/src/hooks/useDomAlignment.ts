// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This hook is a DISPLAY-ONLY validation layer that compares live DOM
// liquidity (from the existing heatmap WS channel) against the
// engine's published structural / liquidity levels (from the existing
// useRegistryLevels hook). It is NOT, and must NEVER become, part of:
//   • level discovery, ranking, persistence, or decay
//   • scoring, pivots, quantile bands, confluence, presets
//   • backtest reliability or any overlay logic
//
// Allowed inputs (read-only):
//   • the same `heatmap:${symbol}` WebSocket channel the chart and the
//     DOM ladder already subscribe to (multiplexed pub/sub fan-out — no
//     extra socket, no extra backend load)
//   • the same `useRegistryLevels(symbol)` hook the chart uses for its
//     horizontal level lines
//   • the chart's published price-axis snapshot (chartAxisBus) for
//     priceDecimals + markPrice fall-back
//
// Forbidden imports — engine INTERNALS (must stay forbidden):
//   • api-server / services / engines (level-generation logic itself)
//   • registry-service internals, decay logic, level-generation code
//   • scoring / confluence / precision / reliability / regime modules
//   • touch / confirmation engine
//
// The output of this hook is purely descriptive. Do NOT use the
// alignment values produced here to mutate the registry, retrain
// scoring, or feed any engine input. If a future feature wants to use
// DOM data to *generate* levels, it must be a separate engine module
// with its own audited path, not this diagnostic.
// =====================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { LiquidityHeatmap } from "@workspace/api-client-react";
import { useChannel } from "./useChannel";
import { useRegistryLevels } from "./useRegistryLevels";
import { normalizeSymbolKey } from "@/datafeed/normalize";
import {
  getChartAxis,
  subscribeChartAxis,
  decimalsForPrice,
  type ChartAxisSnapshot,
} from "@/lib/chartAxisBus";
import {
  computeAlignment,
  deriveTickSize,
  summarize,
  type AlignmentOptions,
  type AlignmentRecord,
  type AlignmentSummary,
  type HeatLevelLike,
} from "@/lib/domAlignment";

export interface UseDomAlignmentResult {
  /** Per-wall alignment records. Sorted by DOM wall size desc. */
  records: AlignmentRecord[];
  /** Aggregate hit-rate metrics. */
  summary: AlignmentSummary;
  /** When the displayed snapshot was computed (monotonic ms). */
  generatedAt: number;
  /** True until the first heatmap delta + first registry payload land. */
  isCold: boolean;
}

const RECOMPUTE_MS = 250; // throttle: 4× per second is plenty for a diagnostic

const EMPTY_SUMMARY: AlignmentSummary = {
  domWallCount: 0,
  matchedDomWalls: 0,
  domCoverageRate: 0,
  registryLevelsInRange: 0,
  registryWithDomSupport: 0,
  registrySupportRate: 0,
  sideAgreeCount: 0,
  sideAgreeTotal: 0,
  sideAgreeRate: 0,
  tickSize: 0,
  markPrice: null,
};

/**
 * Read-only DOM/level alignment diagnostic.
 *
 * Strict consumer pattern (mirrors DomLadderPanel):
 *   - Live depth + mark price → ref, written by the WS channel callback
 *   - Registry levels → React state from useRegistryLevels (already
 *     internally throttled — updates are infrequent)
 *   - Chart axis (priceDecimals fallback) → ref, written by the bus
 *
 * The actual recomputation runs on a throttled interval, NOT on every
 * tick. The order book can fire 5-10× per second; the diagnostic panel
 * doesn't need to refresh that often. Throttling decouples render cost
 * from feed rate without losing freshness for a human reader.
 */
export function useDomAlignment(
  rawSymbol: string | null,
  options: AlignmentOptions = {},
): UseDomAlignmentResult {
  const symbol = useMemo(
    () => (rawSymbol ? normalizeSymbolKey(rawSymbol) : null),
    [rawSymbol],
  );

  // Live depth state (refs — never trigger React re-renders on tick)
  const depthRef = useRef<HeatLevelLike[]>([]);
  const markPriceRef = useRef<number | null>(null);

  // Reset per-symbol so we never display BTC walls for an ETH switch.
  useEffect(() => {
    depthRef.current = [];
    markPriceRef.current = null;
  }, [symbol]);

  // Subscribe to the SAME heatmap channel the chart and the DOM ladder
  // already use. The WS layer is a multiplexed pub/sub so this only
  // adds a listener — no new socket, no new backend subscription.
  useChannel<Partial<LiquidityHeatmap>>(
    symbol ? `heatmap:${symbol}` : null,
    (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (Array.isArray(payload.levels)) {
        depthRef.current = payload.levels as unknown as HeatLevelLike[];
      }
      if (
        typeof payload.markPrice === "number" &&
        Number.isFinite(payload.markPrice) &&
        payload.markPrice > 0
      ) {
        markPriceRef.current = payload.markPrice;
      }
    },
  );

  // Engine-published levels. This hook is the same one the chart uses;
  // we only read its output, never mutate or feed back.
  const registry = useRegistryLevels(symbol);
  const registryRef = useRef(registry);
  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  // Chart axis snapshot (for priceDecimals fallback + a backup mark price).
  const axisRef = useRef<ChartAxisSnapshot | null>(getChartAxis());
  useEffect(() => {
    axisRef.current = getChartAxis();
    return subscribeChartAxis((snap) => {
      axisRef.current = snap;
    });
  }, []);

  // Memoize options so the recompute loop's identity is stable when the
  // caller passes inline {}.
  const optsKey = JSON.stringify(options);
  const stableOpts = useMemo(() => options, [optsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [snapshot, setSnapshot] = useState<UseDomAlignmentResult>(() => ({
    records: [],
    summary: EMPTY_SUMMARY,
    generatedAt: 0,
    isCold: true,
  }));

  useEffect(() => {
    if (!symbol) {
      setSnapshot({
        records: [],
        summary: EMPTY_SUMMARY,
        generatedAt: 0,
        isCold: true,
      });
      return;
    }

    let stopped = false;
    const recompute = () => {
      if (stopped) return;
      const depth = depthRef.current;
      const reg = registryRef.current;
      const axis = axisRef.current;
      const mark =
        markPriceRef.current ??
        (axis && Number.isFinite(axis.markPrice) ? axis.markPrice : null);
      const decimals = axis?.priceDecimals ?? decimalsForPrice(mark ?? 0);
      const tickSize = deriveTickSize(depth, decimals);
      const records = computeAlignment(depth, reg, mark, tickSize, stableOpts);
      const summary = summarize(records, reg, mark, tickSize, stableOpts);
      const isCold = depth.length === 0 || reg.length === 0;
      setSnapshot({
        records,
        summary,
        generatedAt: Date.now(),
        isCold,
      });
    };

    // First compute immediately so the panel doesn't show "cold" for
    // 250ms when there's already cached registry + WS depth waiting.
    recompute();
    const id = setInterval(recompute, RECOMPUTE_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [symbol, stableOpts]);

  return snapshot;
}
