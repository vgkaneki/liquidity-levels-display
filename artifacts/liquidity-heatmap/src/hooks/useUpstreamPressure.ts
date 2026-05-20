import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";

export interface UpstreamPressure {
  hyperliquid: {
    rateLimited: boolean;
    cooldownMsRemaining: number;
    last429AgeMs: number | null;
    effectiveRatePerSec: number;
    baseRatePerSec: number;
    tokensWaiting: number;
    avgWaitMs5m: number;
    maxWaitMs5m: number;
    waitSampleCount5m: number;
    count429_5m: number;
  };
}

export function useUpstreamPressure(pollMs = 30_000): UpstreamPressure | null {
  const [data, setData] = useState<UpstreamPressure | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        if (!cancelled) timer = setTimeout(tick, pollMs);
        return;
      }

      try {
        const res = await fetch(apiUrl("/api/upstream-pressure"), {
          cache: "no-store",
          credentials: "include",
        });

        if (!res.ok) return;

        const json = (await res.json()) as UpstreamPressure;
        if (!cancelled) setData(json);
      } catch {
        // swallow — the dot just stays in its previous state
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    };

    void tick();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollMs]);

  return data;
}
