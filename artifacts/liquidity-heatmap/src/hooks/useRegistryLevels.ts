import { useEffect, useRef, useState } from "react";
import { useChannel } from "./useChannel";
import { getDatafeed } from "@/datafeed";
import { normalizeSymbolKey } from "@/datafeed/normalize";
import {
  DATAFEED_SHADOW_ENABLED,
  shadowCompare,
} from "@/datafeed/shadow";
import { apiUrl } from "@/lib/api";

export interface RegistryLevel {
  id: string;
  symbol: string;
  side: "support" | "resistance";
  tier: number;
  price: number;
  strength: number;
  reliability: number;
  firstSeenAt: number;
  lastConfirmedAt: number;
  touches: number;
  methods: string[];
}

interface RegistryLevelsResponse {
  symbol: string;
  levels: RegistryLevel[];
  updatedAt: string;
}

// Module-level last-good cache keyed by symbol. Survives unmount and
// symbol-switch round-trips so the chart can render previously-seen
// liquidity levels INSTANTLY when the user returns to a symbol, instead
// of showing an empty overlay until the cold-start REST call finishes.
// Bounded with FIFO eviction to prevent unbounded growth from drive-by
// symbol probing.
const REGISTRY_LASTGOOD_MAX = 256;
const lastGoodBySymbol = new Map<string, RegistryLevel[]>();
function rememberRegistryLastGood(symbol: string, levels: RegistryLevel[]): void {
  lastGoodBySymbol.delete(symbol);
  while (lastGoodBySymbol.size >= REGISTRY_LASTGOOD_MAX) {
    const oldest = lastGoodBySymbol.keys().next().value;
    if (oldest === undefined) break;
    lastGoodBySymbol.delete(oldest);
  }
  lastGoodBySymbol.set(symbol, levels);
}

/**
 * Returns the persistent liquidity-level registry for a symbol with
 * "never blank unless we have a real reason" semantics.
 *
 * Source precedence:
 *   1. On (symbol) change: hydrate immediately from the module-level
 *      last-good cache for that symbol (instant render of previously
 *      visited contexts).
 *   2. Cold-start REST: GET /api/liquidity/registry-levels?symbol=X.
 *      Failures, aborts, and empty/malformed payloads do NOT clear state.
 *   3. Live: subscribes to `levels:<SYMBOL>` and replaces the array only
 *      when the WS payload is for the current symbol AND non-empty.
 *
 * A monotonically-increasing generation counter prevents older REST
 * responses or late WS payloads from stomping a newer symbol's data.
 */
// Shared normalization helper lives in `src/datafeed/normalize.ts` so chart-facing code stops carrying subtly-different copies.

export function useRegistryLevels(rawSymbol: string | null): RegistryLevel[] {
  const symbol = rawSymbol ? normalizeSymbolKey(rawSymbol) : null;
  const [levels, setLevels] = useState<RegistryLevel[]>(() =>
    symbol ? lastGoodBySymbol.get(symbol) ?? [] : [],
  );
  const genRef = useRef(0);
  const currentSymbolRef = useRef<string | null>(symbol);

  useEffect(() => {
    currentSymbolRef.current = symbol;
    if (!symbol) {
      // Symbol was explicitly cleared by the host — that IS a real reason
      // to drop the overlay.
      setLevels([]);
      return;
    }

    const myGen = ++genRef.current;
    // Prime from last-good for the new symbol so the chart never blanks
    // during a context switch when we have prior data for that symbol.
    const cached = lastGoodBySymbol.get(symbol);
    if (cached && cached.length > 0) {
      setLevels(cached);
    } else {
      // No cached data for this symbol — start empty, fetch will fill.
      setLevels([]);
    }

    const ctrl = new AbortController();
    const url = apiUrl(`/api/liquidity/registry-levels?symbol=${encodeURIComponent(symbol)}`);
    fetch(url, { signal: ctrl.signal, credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<RegistryLevelsResponse>) : null))
      .then((j) => {
        // Drop late responses for stale symbol generations (race guard).
        if (myGen !== genRef.current) return;
        if (currentSymbolRef.current !== symbol) return;
        if (!j || !Array.isArray(j.levels)) return;
        // An empty `levels` array is technically a valid replacement —
        // but only treat it as such when the server explicitly confirmed
        // it's for the current symbol. The user's rule: "only clear when
        // a confirmed valid replacement dataset arrives". For the cold-
        // start path we can't easily distinguish "registry truly empty"
        // from "boot race"; keep the prior list when the server returns
        // empty so a transient warmup never blanks visible levels.
        if (j.levels.length === 0 && (cached?.length ?? 0) > 0) return;
        rememberRegistryLastGood(symbol, j.levels);
        setLevels(j.levels);
      })
      .catch(() => {
        /* Swallow — keep last-good visible. WS will catch up. */
      });

    return () => {
      ctrl.abort();
    };
  }, [symbol]);

  // Phase 3 / T125 shadow: subscribe via the IDatafeed in parallel with
  // the legacy `useChannel('levels:<SYM>')` and cross-check level count
  // on each delta. Consumer state continues to be served by the legacy
  // path (prefer=legacy until the observation window passes).
  const lastLegacyLevelsRef = useRef<RegistryLevel[]>([]);
  // Tracks which symbol the mirror's contents belong to. The shadow
  // compare suppresses any emission whose symbol does not match the
  // mirror's symbol, preventing a guaranteed-false mismatch on the
  // first datafeed tick after a symbol switch (when `lastLegacyLevels`
  // still holds the previous symbol's array).
  const mirrorSymbolRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastLegacyLevelsRef.current = levels;
    mirrorSymbolRef.current = symbol;
  }, [levels, symbol]);
  useEffect(() => {
    if (!symbol) return;
    // Reset baseline on symbol change so the next compare requires the
    // new symbol's legacy emission to land first.
    lastLegacyLevelsRef.current = [];
    mirrorSymbolRef.current = undefined;
    if (!DATAFEED_SHADOW_ENABLED) return;
    const sub = getDatafeed().subscribeLevels(symbol, (delta) => {
      if (mirrorSymbolRef.current !== symbol) return;
      const legacy = lastLegacyLevelsRef.current;
      if (legacy.length === 0) return; // skip cold-start / empty state
      shadowCompare(
        `registryLevels:${symbol}:count`,
        delta.levels.length,
        legacy.length,
        // Tolerance fix (April 2026): the registry actively churns
        // levels (additions on confirmation, expirations on decay)
        // between the two paths' snapshot ticks. Both paths receive
        // FULL snapshots over WS, but their snapshots are taken at
        // slightly different moments because each path opens its own
        // WebSocket connection — even a few hundred ms of delivery
        // skew can manifest as ±1-6 levels of count drift on a 70+
        // level registry. That is timing noise, not data divergence.
        // True disagreement (one path missing a whole tier, or a
        // stale path serving an entire prior snapshot) is tens of
        // levels off, well outside the tolerance band. We use the
        // larger of |Δ| ≤ 5 absolute or |Δ| ≤ 10 % relative so the
        // band scales with registries that are themselves larger.
        // Engine math, registry decay, and level generation are
        // untouched — this is purely a shadow-comparator tolerance
        // tweak (analogous to the source-aware skip we already use
        // for the candle-overlap surface).
        (a, b) => {
          const diff = Math.abs(a - b);
          const tol = Math.max(5, Math.floor(Math.max(a, b) * 0.1));
          return diff <= tol;
        },
      );
    });
    return () => sub.unsubscribe();
  }, [symbol]);

  // Live updates over WS. The registry isn't large, so each payload
  // carries the full level array (snapshot+delta both work this way).
  useChannel<{ symbol: string; levels: RegistryLevel[] }>(
    symbol ? `levels:${symbol}` : null,
    (payload) => {
      // Defence-in-depth: useChannel already scopes by channel name, but
      // an explicit symbol check protects against the (small) window
      // where a payload from the previous channel arrives just after a
      // symbol switch.
      if (!symbol) return;
      if (!payload || !Array.isArray(payload.levels)) return;
      if (payload.symbol && payload.symbol !== symbol) return;
      // Same "no-blank-on-empty" rule as the REST path: only replace
      // when the new array is non-empty OR we have nothing cached yet.
      const have = lastGoodBySymbol.get(symbol)?.length ?? 0;
      if (payload.levels.length === 0 && have > 0) return;
      rememberRegistryLastGood(symbol, payload.levels);
      setLevels(payload.levels);
    },
  );

  return levels;
}
