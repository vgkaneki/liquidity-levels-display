import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

export interface AnalyticsFunding {
  current: number | null;
  mean: number | null;
  zScore: number | null;
  samples: { t: number; rate: number }[];
}
export interface AnalyticsOiDelta {
  current: number | null;
  currentUsd: number | null;
  samples: { t: number; oi: number; oiUsd: number; deltaBps: number | null }[];
}
export interface AnalyticsTakerPressure {
  currentRatio: number | null;
  samples: { t: number; ratio: number; buyUsd: number; sellUsd: number }[];
}
export interface AnalyticsCvd {
  latestNotional: number;
  samples: { t: number; cvdNotional: number }[];
}
export interface AnalyticsOverlaysData {
  symbol: string;
  funding: AnalyticsFunding;
  oiDelta: AnalyticsOiDelta;
  takerPressure: AnalyticsTakerPressure;
  cvd: AnalyticsCvd;
}
export interface MagnetCluster {
  bucketPrice: number;
  bucketLow: number;
  bucketHigh: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
}

/**
 * Polls the analytics-overlay endpoints every {pollMs}ms while any one of
 * the five overlays is enabled, otherwise stays idle. Two endpoints are
 * fetched together — /analytics for the four time-series overlays and
 * /liquidations/clusters for the magnet zones — so a single tick refreshes
 * all overlays.
 */
export function useAnalyticsOverlays(
  symbol: string | undefined,
  enabled: boolean,
  windowMs = 30 * 60_000,
  pollMs = 15_000,
): { analytics: AnalyticsOverlaysData | null; magnets: MagnetCluster[] } {
  const [analytics, setAnalytics] = useState<AnalyticsOverlaysData | null>(null);
  const [magnets, setMagnets] = useState<MagnetCluster[]>([]);

  useEffect(() => {
    if (!enabled || !symbol) {
      setAnalytics(null);
      setMagnets([]);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      // Skip overlapping ticks: if a slow request is still in flight when the
      // 5s timer fires we drop the new poll instead of fanning out parallel
      // requests for the same symbol.
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const [aRes, mRes] = await Promise.all([
          fetch(apiUrl(`/api/liquidity/analytics/${encodeURIComponent(symbol)}?windowMs=${windowMs}`), { credentials: "include", signal: controller.signal }),
          fetch(apiUrl(`/api/liquidity/liquidations/clusters?symbol=${encodeURIComponent(symbol)}&windowMs=900000&limit=20`), { credentials: "include", signal: controller.signal }),
        ]);
        if (cancelled) return;
        if (aRes.ok) {
          const j = await aRes.json();
          setAnalytics(j);
        }
        if (mRes.ok) {
          const j = await mRes.json();
          setMagnets(Array.isArray(j?.clusters) ? j.clusters : []);
        }
      } catch {
        // ignore — keep last data (also swallows AbortError on unmount)
      } finally {
        inFlight = false;
      }
    };
    // chartRequestDebounceV1: do not fire overlay requests immediately during
    // symbol/timeframe transitions. Give the primary candle/level requests a
    // short head start, then poll at the configured cadence.
    const firstPollDelayMs = Math.max(
      1_000,
      Number(import.meta.env.VITE_ANALYTICS_OVERLAY_INITIAL_DELAY_MS ?? "1500") || 1_500,
    );
    const firstPollTimer = window.setTimeout(() => void poll(), firstPollDelayMs);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void poll();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(firstPollTimer);
      window.clearInterval(id);
      controller?.abort();
    };
  }, [symbol, enabled, windowMs, pollMs]);

  return { analytics, magnets };
}
