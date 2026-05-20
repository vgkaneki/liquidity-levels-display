import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";
import { getDatafeed } from "@/datafeed";
import {
  DATAFEED_SHADOW_ENABLED,
  shadowCompare,
} from "@/datafeed/shadow";

export interface LiquidationCluster {
  bucketPrice: number;
  bucketLow: number;
  bucketHigh: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
  lastTimestamp: string;
}

/**
 * Polls /liquidity/liquidations/clusters for the given symbol while
 * `enabled` is true. Returns aggregated, time-windowed liquidation
 * clusters (real executed liquidation volume from OKX + Hyperliquid).
 *
 * This is the data source for the "Liquidation Heatmap (Real)" chart
 * indicator. The leverage-projection variant has its own client-side
 * compute and does not use this hook.
 *
 * Phase 3 / T125: alongside the legacy poll, the hook subscribes to the
 * IDatafeed's `subscribeLiquidations` and cross-checks each emission
 * (cluster count + first bucketPrice) against the latest legacy result.
 * Disagreements log as `[datafeed-mismatch] liquidations:<SYM>:...`.
 * The consumer continues to receive the legacy poll's value
 * (prefer=legacy) until the observation week is clean and a follow-up
 * task removes the legacy path.
 */
export function useLiquidationClusters(
  symbol: string | undefined,
  enabled: boolean,
  windowMs = 15 * 60_000,
  pollMs = 30_000,
): LiquidationCluster[] {
  const [clusters, setClusters] = useState<LiquidationCluster[]>([]);
  // Mirror of the latest legacy emission so the shadow callback always
  // has a comparable value without re-rendering. Updated by the effect
  // below whenever `clusters` changes.
  const legacyMirror = useRef<LiquidationCluster[]>([]);
  useEffect(() => {
    legacyMirror.current = clusters;
  }, [clusters]);

  useEffect(() => {
    if (!enabled || !symbol) {
      setClusters([]);
      legacyMirror.current = [];
      return;
    }

    // Reset the legacy mirror on symbol/enabled/window change so the
    // shadow never compares a fresh emission for the new key against
    // stale state from the previous key (would log a guaranteed
    // mismatch). Note: we deliberately do NOT clear `clusters` state
    // here — the chart keeps painting the prior symbol's data for a
    // single frame until the new poll lands, matching pre-T125
    // behaviour exactly. The mirror is the only thing the shadow
    // compare reads, so resetting it alone is sufficient.
    legacyMirror.current = [];

    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (inFlight) return;

      inFlight = true;
      controller = new AbortController();

      try {
        const url = apiUrl(
          `/api/liquidity/liquidations/clusters?symbol=${encodeURIComponent(
            symbol,
          )}&windowMs=${windowMs}&limit=50`,
        );

        const res = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
          cache: "no-store",
        });

        if (cancelled) return;

        if (res.ok) {
          const json = await res.json();
          setClusters(Array.isArray(json?.clusters) ? json.clusters : []);
        }
      } catch {
        // ignore — keep last data (also swallows AbortError on unmount)
      } finally {
        inFlight = false;
      }
    };

    // chartRequestDebounceV1: liquidations are secondary overlays. Delay the
    // first poll so fast interval changes do not launch obsolete requests, and
    // skip periodic polls while hidden.
    const firstPollDelayMs = Math.max(
      1_000,
      Number(import.meta.env.VITE_LIQUIDATION_CLUSTER_INITIAL_DELAY_MS ?? "1500") || 1_500,
    );
    const firstPollTimer = window.setTimeout(() => void poll(), firstPollDelayMs);
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void poll();
    }, pollMs);

    // Phase 3 / T125 shadow: parallel datafeed subscription. Compares
    // cluster count + first bucketPrice; emissions where the legacy
    // mirror is empty (cold start) are skipped to avoid bootup noise.
    let shadowSub: { unsubscribe(): void } | null = null;
    if (DATAFEED_SHADOW_ENABLED) {
      shadowSub = getDatafeed().subscribeLiquidations(
        symbol,
        (snap) => {
          if (cancelled) return;
          const legacy = legacyMirror.current;
          if (legacy.length === 0) return;
          shadowCompare(
            `liquidations:${symbol}:countAndFirstBucket`,
            {
              count: snap.clusters.length,
              firstBucketPrice: snap.clusters[0]?.bucketPrice ?? 0,
            },
            {
              count: legacy.length,
              firstBucketPrice: legacy[0]?.bucketPrice ?? 0,
            },
            (a, b) =>
              a.count === b.count &&
              Math.abs(a.firstBucketPrice - b.firstBucketPrice) < 1e-9,
          );
        },
        { intervalMs: pollMs, windowMs },
      );
    }

    return () => {
      cancelled = true;
      window.clearTimeout(firstPollTimer);
      window.clearInterval(id);
      controller?.abort();
      shadowSub?.unsubscribe();
    };
  }, [symbol, enabled, windowMs, pollMs]);

  return clusters;
}
