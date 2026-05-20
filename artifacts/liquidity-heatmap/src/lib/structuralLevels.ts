import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { getDatafeed } from "@/datafeed";
import {
  DATAFEED_SHADOW_ENABLED,
  logDatafeedMismatch,
  shadowCompare,
} from "@/datafeed/shadow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuralZone {
  priceLow: number;
  priceHigh: number;
  midPrice?: number;
  score: number;
  kind: "support" | "resistance" | "neutral";
  methods: string[];
  preciseEntryPrice: number;
  entryMethod: string;
  bounceRate: number | null;
  pValue: number | null;
  posteriorBounceRate: number | null;
  confirmed: boolean;
  confidence: "high" | "medium" | "low";
  confirmingTimeframe: string | null;
  crossAssetConfirmed: boolean;
}

export interface StructuralSignal {
  name: string;
  value: number;
  label: string;
  direction: string;
}

export interface StructuralAi {
  summary: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  recommendedEntry: number | null;
  direction: "long" | "short" | "neutral";
  reasoning: string[];
  consistency: string;
}

export interface StructuralLevelsResponse {
  symbol: string;
  interval: string;
  currentPrice: number;
  regime: {
    hurst: number;
    label?: string;
    regimeLabel?: string;
    vol?: number;
    garchVolatility?: number;
    garchRegime?: "low" | "normal" | "high";
    signalWeightMultiplier?: number;
  };
  zones: StructuralZone[];
  signals?: StructuralSignal[];
  divergences?: Array<{
    time: number;
    price: number;
    kind: string;
    magnitude: number;
  }>;
  kde?: Array<{ price: number; density: number }>;
  liquidations?: Array<{ price: number; density: number; leverage: number }>;
  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;
  ai?: StructuralAi;
  generatedAt: number;
  source?: "live";
  higherTimeframe?: string | null;
  unsupported?: boolean;
  dataSource?: "hyperliquid" | "toobit" | null;
  /**
   * True when the server served a route-level last-good fallback because a
   * fresh compute failed (transient upstream error). Sourced from body
   * `stale: true` and/or the `X-Levels-Stale: 1` response header. The chart
   * surfaces this with a visible badge.
   */
  stale?: boolean;
  /**
   * Age (ms) of the stale payload at the moment it was fetched, when the
   * server included it. Used to render "stale 2m" style hints in the UI.
   */
  staleAgeMs?: number;
}

export interface UseStructuralLevelsOptions {
  symbol: string;
  interval: string;
  enabled: boolean;
  pollMs?: number;
  minConfidence?: "high" | "medium" | "low";
  methodsAllowed?: Record<string, boolean>;
}

export interface UseStructuralLevelsResult {
  data: StructuralLevelsResponse | null;
  filteredZones: StructuralZone[];
  isLoading: boolean;
  error: string | null;
  unsupported: boolean;
  dataSource: "hyperliquid" | "toobit" | null;
  /**
   * True when the most recent successful response was a server-side last-good
   * fallback. Surface this as a visible "Levels delayed" badge.
   */
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Internal registry types
// ---------------------------------------------------------------------------

type Subscriber = {
  pollMs: number;
  onData: (data: StructuralLevelsResponse) => void;
  onError: (err: Error) => void;
  onLoading: (isLoading: boolean) => void;
};

type RegistryEntry = {
  symbol: string;
  interval: string;
  subscribers: Set<Subscriber>;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  latest: StructuralLevelsResponse | null;
  visibilityListener: (() => void) | null;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Active (symbol|interval) fetch registry. One entry per unique pair. */
const registry = new Map<string, RegistryEntry>();

/**
 * Persistent last-good cache keyed by `${symbol}|${interval}`. Survives
 * unsubscribe so re-visiting a previously loaded symbol renders instantly.
 * Bounded at STRUCTURAL_LASTGOOD_MAX entries via LRU-style FIFO eviction.
 */
const STRUCTURAL_LASTGOOD_MAX = 256;
const lastGoodBySymInt = new Map<string, StructuralLevelsResponse>();

/**
 * Per-key latch so the `missingPrimaryRawZones` shadow-compare warning is
 * emitted at most once per (symbol|interval) per process lifetime.
 */
const _missingPrimaryRawZonesLogged = new Set<string>();

// ---------------------------------------------------------------------------
// Last-good cache helpers
// ---------------------------------------------------------------------------

function rememberStructuralLastGood(
  key: string,
  data: StructuralLevelsResponse,
): void {
  // Delete first to refresh insertion order (keeps popular keys warm under FIFO evict).
  lastGoodBySymInt.delete(key);
  while (lastGoodBySymInt.size >= STRUCTURAL_LASTGOOD_MAX) {
    const oldest = lastGoodBySymInt.keys().next().value;
    if (oldest === undefined) break;
    lastGoodBySymInt.delete(oldest);
  }
  lastGoodBySymInt.set(key, data);
}

export function __getStructuralLastGood(
  symbol: string,
  interval: string,
): StructuralLevelsResponse | null {
  return lastGoodBySymInt.get(`${symbol}|${interval}`) ?? null;
}

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

/**
 * Warms the client last-good cache (and the server TtlCache via a one-shot
 * fetch) for a (symbol, interval) the user is likely to visit next. Callers
 * should fire this during idle time so adjacent timeframe clicks render
 * instantly.
 *
 * No-ops when:
 *  - already cached (last-good exists for the key)
 *  - an active fetch is already in flight for the key
 *  - the document is backgrounded (save bandwidth)
 */
export function prefetchStructuralLevels(symbol: string, interval: string): void {
  if (!symbol || !interval) return;
  const key = `${symbol}|${interval}`;
  if (lastGoodBySymInt.has(key)) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const existing = registry.get(key);
  if (existing?.controller) return;

  // Use a dummy subscriber with pollMs=0 so it never arms a follow-up poll.
  // It self-removes as soon as the first onData or onError fires.
  let unsubscribe: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const done = () => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    if (unsubscribe !== null) {
      const u = unsubscribe;
      unsubscribe = null;
      // Defer the unsubscribe to avoid mutating the subscriber set while
      // runFetch is iterating over it in its notify loop.
      Promise.resolve().then(u);
    }
  };

  const sub: Subscriber = {
    pollMs: 0,
    onData: done,
    onError: done,
    onLoading: () => {},
  };

  unsubscribe = subscribe(symbol, interval, sub);

  // Safety watchdog: some fetch outcomes (malformed payload, pending skeleton
  // when there is no last-good) return from runFetch without calling onData or
  // onError. Without this the dummy subscriber would linger indefinitely and
  // cause later real subscribers to skip their immediate fetch.
  watchdog = setTimeout(done, 15_000);
}

// ---------------------------------------------------------------------------
// Registry utilities
// ---------------------------------------------------------------------------

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Returns the shortest pollMs across all active subscribers, or 0 if none poll. */
function effectivePollMs(entry: RegistryEntry): number {
  let min = Infinity;
  for (const sub of entry.subscribers) {
    if (sub.pollMs > 0 && sub.pollMs < min) min = sub.pollMs;
  }
  return Number.isFinite(min) ? min : 0;
}

function clearTimer(entry: RegistryEntry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** Arm the next regular-cadence poll timer. */
function scheduleNext(entry: RegistryEntry): void {
  clearTimer(entry);
  const period = effectivePollMs(entry);
  if (period <= 0) return;
  entry.timer = setTimeout(() => void runFetch(entry), period);
}

/**
 * Arm an accelerated retry timer (cold-start / empty-zone / pending-skeleton).
 * Clears any existing timer first so we never double-fire.
 */
function scheduleSoon(entry: RegistryEntry, delayMs: number): void {
  clearTimer(entry);
  entry.timer = setTimeout(() => void runFetch(entry), delayMs);
}

// ---------------------------------------------------------------------------
// Core fetch loop
// ---------------------------------------------------------------------------

async function runFetch(entry: RegistryEntry): Promise<void> {
  if (entry.subscribers.size === 0) return;

  // Skip work while the tab is backgrounded; reschedule so we don't fall silent.
  if (isHidden()) {
    scheduleNext(entry);
    return;
  }

  // Another fetch is already in flight — don't stack concurrent requests.
  if (entry.controller !== null) return;

  const controller = new AbortController();
  entry.controller = controller;

  for (const sub of entry.subscribers) sub.onLoading(true);

  // Tracks whether this invocation already armed a fast-retry so the finally
  // block doesn't clobber it with the normal poll timer.
  let scheduledSoon = false;

  try {
    const url = apiUrl(
      `/api/levels?symbol=${encodeURIComponent(entry.symbol)}&interval=${encodeURIComponent(entry.interval)}`,
    );

    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
      headers: {
        // Foreground structural-zone requests get priority routing so
        // scanner/background work doesn't delay the active chart.
        "x-fetch-priority": "high",
        "x-foreground-chart": "1",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    // Stale flag: set by server when serving route-level last-good fallback.
    // Accept both the custom header and body field in case a proxy strips headers.
    const headerStale = res.headers.get("X-Levels-Stale") === "1";

    // Pending flag: server is in HL 429 backoff with no server-side last-good.
    // The body is an intentional empty shell — keep painting whatever the chart
    // already has while the real compute lands.
    const headerPending = res.headers.get("X-Levels-Pending") === "1";

    const json = (await res.json()) as StructuralLevelsResponse;

    // --- Shape validation ---
    // A payload is only usable if it is a non-null object with a zones array
    // and is not a pending skeleton. Anything else must not clobber last-good.
    const isPendingSkeleton =
      headerPending ||
      (json != null &&
        typeof json === "object" &&
        (json as { pending?: boolean }).pending === true);

    const isWellFormed =
      json != null &&
      typeof json === "object" &&
      Array.isArray(json.zones);

    const isUsable = isWellFormed && !isPendingSkeleton;

    // --- Transient-empty guard ---
    // When the server returns zones:[] but we already have a good payload,
    // treat it as a transient blip (cold-start race / rate pressure) and retry
    // quickly rather than wiping the visible overlay.
    const hasLastGoodZones =
      Array.isArray(entry.latest?.zones) && (entry.latest?.zones.length ?? 0) > 0;

    const isTransientEmptyReplacement =
      isUsable &&
      (json.zones as unknown[]).length === 0 &&
      hasLastGoodZones &&
      json.unsupported !== true;

    if (!isUsable || isTransientEmptyReplacement) {
      // Keep last-good visible; schedule a fast retry for recoverable states.
      if (isPendingSkeleton || isTransientEmptyReplacement) {
        scheduledSoon = true;
        scheduleSoon(entry, 5_000);
      }
      return;
    }

    // --- Cold-start empty guard ---
    // zones:[] with no prior last-good during startup. Don't accept it as the
    // first visible state; retry quickly until a real compute arrives.
    if ((json.zones as unknown[]).length === 0 && json.unsupported !== true) {
      scheduledSoon = true;
      scheduleSoon(entry, 5_000);
      return;
    }

    // --- Accept the payload ---
    if (headerStale && json.stale !== true) json.stale = true;
    entry.latest = json;
    rememberStructuralLastGood(`${entry.symbol}|${entry.interval}`, json);

    for (const sub of entry.subscribers) {
      sub.onData(json);
    }

    // --- Shadow compare (T125 S4) ---
    // Cross-check structural zone count from the /api/levels REST response
    // against the IDatafeed adapter's fetchLevels output. The comparison is
    // zone-count vs zone-count (both come from json.zones), not LevelItem
    // count (a different schema). Best-effort — never surfaces to users.
    if (DATAFEED_SHADOW_ENABLED) {
      void (async () => {
        try {
          const primary = await getDatafeed().fetchLevels({
            symbol: entry.symbol,
            interval: entry.interval,
          });
          const legacyZones = Array.isArray(json.zones) ? json.zones : [];
          if (legacyZones.length === 0) return; // skip cold-start noise

          const primaryRaw = (primary.raw ?? null) as { zones?: unknown[] } | null;
          const primaryZones = Array.isArray(primaryRaw?.zones)
            ? (primaryRaw!.zones as unknown[])
            : null;

          if (primaryZones === null) {
            // Instrumentation degradation: IDatafeed stopped surfacing raw.zones.
            // Log once per key so maintainers can detect adapter regressions
            // without flooding the console on every poll.
            const key = `${entry.symbol}|${entry.interval}`;
            if (!_missingPrimaryRawZonesLogged.has(key)) {
              _missingPrimaryRawZonesLogged.add(key);
              logDatafeedMismatch(
                `structuralLevels:${key}:missingPrimaryRawZones`,
                {
                  legacyZoneCount: legacyZones.length,
                  rawType:
                    primary.raw === undefined
                      ? "undefined"
                      : primary.raw === null
                        ? "null"
                        : typeof primary.raw,
                },
              );
            }
            return;
          }

          shadowCompare(
            `structuralLevels:${entry.symbol}|${entry.interval}:zoneCount`,
            primaryZones.length,
            legacyZones.length,
            (a, b) => a === b,
          );
        } catch {
          // Shadow path is best-effort — never surface to users.
        }
      })();
    }
  } catch (err) {
    // Abort errors are normal cleanup — not subscriber errors.
    if ((err as Error).name === "AbortError") return;

    // Surface the error for status badges but do NOT wipe last-good data.
    // The hook layer keeps rendering the previous successful response.
    for (const sub of entry.subscribers) {
      sub.onError(err as Error);
    }
  } finally {
    if (entry.controller === controller) {
      entry.controller = null;
    }

    for (const sub of entry.subscribers) {
      sub.onLoading(false);
    }

    // Only arm the normal poll timer when we haven't already armed a fast retry.
    // If scheduledSoon=true, scheduleSoon() already set entry.timer.
    if (!scheduledSoon) {
      scheduleNext(entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------

function subscribe(
  symbol: string,
  interval: string,
  sub: Subscriber,
): () => void {
  const key = `${symbol}|${interval}`;
  let entry = registry.get(key);

  if (!entry) {
    entry = {
      symbol,
      interval,
      subscribers: new Set(),
      timer: null,
      controller: null,
      // Hydrate from the persistent last-good so a re-subscribe (user
      // switched symbol away and back) serves the cached response instantly
      // while a fresh background fetch is in flight.
      latest: lastGoodBySymInt.get(key) ?? null,
      visibilityListener: null,
    };
    registry.set(key, entry);

    // Wake up immediately when the tab becomes visible so users don't see
    // stale data after the app was backgrounded.
    if (typeof document !== "undefined") {
      const currentEntry = entry;
      const onVis = () => {
        if (!isHidden() && registry.get(key) === currentEntry) {
          if (currentEntry.controller !== null) return;
          clearTimer(currentEntry);
          void runFetch(currentEntry);
        }
      };
      entry.visibilityListener = onVis;
      document.addEventListener("visibilitychange", onVis);
    }
  }

  entry.subscribers.add(sub);

  // Serve cached data synchronously so the UI never flickers to empty.
  if (entry.latest !== null) {
    sub.onData(entry.latest);
  }

  if (entry.subscribers.size === 1) {
    // First subscriber — kick off an immediate fetch.
    void runFetch(entry);
  } else if (entry.timer === null && entry.controller === null) {
    // Additional subscriber joined while idle — ensure the timer is armed.
    scheduleNext(entry);
  }

  return () => {
    const existing = registry.get(key);
    if (!existing) return;

    existing.subscribers.delete(sub);

    if (existing.subscribers.size === 0) {
      // Last subscriber left — tear down completely.
      clearTimer(existing);

      if (existing.controller !== null) {
        try {
          existing.controller.abort();
        } catch {
          // Ignore — AbortController.abort() is safe to call multiple times.
        }
        existing.controller = null;
      }

      if (existing.visibilityListener !== null && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", existing.visibilityListener);
        existing.visibilityListener = null;
      }

      registry.delete(key);
    } else {
      // A subscriber left but others remain — recalculate the poll cadence.
      scheduleNext(existing);
    }
  };
}

// ---------------------------------------------------------------------------
// Debug / observability exports
// ---------------------------------------------------------------------------

export function __getStructuralRegistryStats(): {
  keys: number;
  totalSubscribers: number;
} {
  let total = 0;
  for (const entry of registry.values()) {
    total += entry.subscribers.size;
  }
  return { keys: registry.size, totalSubscribers: total };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

const CONF_RANK: Record<"high" | "medium" | "low", number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function useStructuralLevels(
  opts: UseStructuralLevelsOptions,
): UseStructuralLevelsResult {
  const {
    symbol,
    interval,
    enabled,
    pollMs = 120_000,
    minConfidence = "low",
    methodsAllowed,
  } = opts;

  const [data, setData] = useState<StructuralLevelsResponse | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !symbol) {
      setData(null);
      setError(null);
      return;
    }

    // Prime state from the last-good cache for the new (symbol, interval) key
    // so previously visited contexts render instantly. If there's no cache hit
    // for the new key we set null — it would be wrong to keep showing the
    // previous symbol's zones on a different chart.
    setData(lastGoodBySymInt.get(`${symbol}|${interval}`) ?? null);
    setError(null);

    let cancelled = false;

    const sub: Subscriber = {
      pollMs,
      onData: (nextData) => {
        if (cancelled) return;
        // Safety: `cancelled` is set true in cleanup before any replacement
        // subscription is created, so a stale onData from a previous
        // (symbol, interval) pair can never land here.
        setData(nextData);
        setError(null);
      },
      onError: (nextError) => {
        if (cancelled) return;
        // Surface the error for status badges but preserve the last-good data.
        setError(nextError.message);
      },
      onLoading: (loading) => {
        if (!cancelled) setLoading(loading);
      },
    };

    // Debounce rapid timeframe sweeps: delay the actual subscription slightly
    // so intermediate intervals that will be immediately replaced never issue
    // a network request. Last-good is primed synchronously above so revisited
    // contexts are already rendering while the debounce timer winds down.
    let unsubscribe: (() => void) | null = null;
    const debounceMs = Math.max(
      0,
      Number(import.meta.env.VITE_STRUCTURAL_FETCH_DEBOUNCE_MS ?? "350") || 350,
    );

    const subscribeTimer = window.setTimeout(() => {
      if (cancelled) return;
      unsubscribe = subscribe(symbol, interval, sub);
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(subscribeTimer);
      unsubscribe?.();
    };
  }, [symbol, interval, enabled, pollMs]);

  // Filter zones by confidence rank and allowed methods. Runs on every render
  // so changes to minConfidence/methodsAllowed take effect without re-fetching.
  const minRank = CONF_RANK[minConfidence];

  const filteredZones = (data?.zones ?? []).filter((zone) => {
    if (CONF_RANK[zone.confidence] < minRank) return false;
    if (methodsAllowed) {
      const anyAllowed = zone.methods.some((m) => methodsAllowed[m] !== false);
      if (!anyAllowed) return false;
    }
    return true;
  });

  return {
    data,
    filteredZones,
    isLoading,
    error,
    unsupported: data?.unsupported === true,
    dataSource: data?.dataSource ?? null,
    stale: data?.stale === true,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const STRUCTURAL_METHOD_LABELS: Record<string, string> = {
  "kde-pivot-cluster": "KDE pivot cluster",
  "market-profile-poc": "Market Profile POC",
  "value-area-high": "Value Area High",
  "value-area-low": "Value Area Low",
  "swing-pivot": "Swing pivot",
  "quantile-band": "Quantile band",
};

export function structuralZoneColor(z: StructuralZone): {
  stroke: string;
  fill: string;
} {
  if (z.confidence === "high") {
    return z.kind === "support"
      ? { stroke: "#10b981", fill: "rgba(16,185,129,0.18)" }
      : { stroke: "#f43f5e", fill: "rgba(244,63,94,0.18)" };
  }
  if (z.confidence === "medium") {
    return z.kind === "support"
      ? { stroke: "#34d399", fill: "rgba(52,211,153,0.12)" }
      : { stroke: "#fb7185", fill: "rgba(251,113,133,0.12)" };
  }
  return z.kind === "support"
    ? { stroke: "#6ee7b7", fill: "rgba(110,231,183,0.07)" }
    : { stroke: "#fda4af", fill: "rgba(253,164,175,0.07)" };
}
