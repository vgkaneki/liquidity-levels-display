// Host-layer adapter for the canonical horizontal-levels engine.
//
// The standalone engine (services/orchestrator.ts, services/hyperliquid.ts,
// services/cache.ts, etc.) is preserved byte-for-byte from the upstream
// release. Two host concerns live OUTSIDE the engine and are handled here:
//
//   1. Symbol / interval normalization. The engine and Hyperliquid expect
//      `coin: "BTC"` and lowercase intervals like `"4h"`. The rest of this
//      app (chart, scanner, registry, warm list) speaks `BTCUSDT` and
//      uppercase `"4H"`. We translate at the boundary so neither side has
//      to change.
//
//   2. Level-registry ingestion. The legacy orchestrator called
//      `levelRegistry.recordZones(symbol, zones)` on every successful
//      compute so the persisted, WS-broadcast registry stayed in sync.
//      The standalone engine doesn't know about the registry; we attach
//      that side effect here on every cache miss.

import { getCachedLevels, scheduleLevelsRefresh } from "./orchestrator";
import { levelRegistry } from "./levelRegistry";
import { logger } from "../lib/logger";

type LevelsCachedResult = Awaited<ReturnType<typeof getCachedLevels>>;

export function normalizeCoin(rawSymbol: string): string {
  // Accepts the chart-native perp symbol (`BTCUSDT`, `BTC-USDT`) or a
  // bare coin (`BTC`) and returns the HL coin name.
  return rawSymbol.replace(/-/g, "").toUpperCase().replace(/USDT$/, "");
}

export function normalizeInterval(rawInterval: string): string {
  return rawInterval.toLowerCase();
}

export function denormalizePerpSymbol(coin: string): string {
  // The registry, WS hub, and frontend all key on `${COIN}USDT`. Round-trip
  // back to that shape so registry rows and WS channel names are unchanged.
  return `${coin.toUpperCase()}USDT`;
}

export async function getCachedLevelsAndRecord(
  rawSymbol: string,
  rawInterval: string,
): Promise<LevelsCachedResult> {
  const coin = normalizeCoin(rawSymbol);
  const interval = normalizeInterval(rawInterval);
  const result = await getCachedLevels(coin, interval);
  // Feed the registry only on a fresh compute (cache miss). Cache hits
  // would just re-record the same zones every poll cycle and add noise
  // to the dirty-set debounce.
  if (!result.hit) {
    try {
      const perpSym = denormalizePerpSymbol(coin);
      levelRegistry.recordZones(perpSym, result.value.zones as Parameters<typeof levelRegistry.recordZones>[1]);
    } catch (e) {
      logger.warn({ err: e, coin, interval }, "levelRegistry.recordZones failed");
    }
  }
  return result;
}

export function scheduleNormalizedLevelsRefresh(rawSymbol: string, rawInterval: string): void {
  const coin = normalizeCoin(rawSymbol);
  const interval = normalizeInterval(rawInterval);
  scheduleLevelsRefresh(coin, interval);
}
