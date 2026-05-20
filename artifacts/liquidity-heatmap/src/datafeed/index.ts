// Phase 3 — Public datafeed entry point.
//
// `getDatafeed()` returns a process-singleton instance of the production
// IDatafeed implementation. `useDatafeed()` is a tiny React hook for
// components that want stable identity across renders.
//
// The hook exists ONLY so React consumers don't write `getDatafeed()`
// inline in render and confuse the rules-of-hooks linter. There is no
// per-component state — every call returns the same instance.
//
// Tests and the debug harness can import the production class directly
// from `./HttpDatafeed` if they need to bypass the singleton.

import { useMemo } from "react";
import type { IDatafeed } from "./types";
import { getHttpDatafeed } from "./HttpDatafeed";

let datafeedSingleton: IDatafeed | null = null;

export function getDatafeed(): IDatafeed {
  if (!datafeedSingleton) datafeedSingleton = getHttpDatafeed();
  return datafeedSingleton;
}

export function useDatafeed(): IDatafeed {
  // useMemo with empty deps gives stable identity without an effect.
  return useMemo(() => getDatafeed(), []);
}

// Re-export the contract surface so callers only need one import path.
export type {
  IDatafeed,
  SymbolInfo,
  Bar,
  Resolution,
  CandlesRequest,
  CandlesResponse,
  BarsSubRequest,
  MarkTick,
  LevelItem,
  LevelsRequest,
  LevelsResponse,
  LevelsDelta,
  DepthSnapshot,
  DepthLevel,
  LiqCluster,
  LiqClustersSnapshot,
  Subscription,
} from "./types";
export { INTERVAL_MS } from "./types";
export { withLegacyFallback } from "./legacyFallback";

// Test-only resets, exposed for the harness and future tests.
export function __resetDatafeedSingleton(): void {
  datafeedSingleton = null;
}
