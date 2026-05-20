// Phase 3 — Shadow / disagreement helpers used by the T125 frontend
// migration.
//
// The migration pattern (mirroring Phase 1 SymbolRegistry rollout) is:
//
//   * The legacy data path keeps running and is what the user sees.
//   * The new IDatafeed call runs in parallel.
//   * On every emission we compare the two and log a structured
//     `[datafeed-mismatch]` line when they disagree.
//   * After ~1 quiet observation week, a follow-up task removes the
//     legacy code path and the shadow.
//
// `withLegacyFallback` (in legacyFallback.ts) handles promise-based
// callsites. This module covers the subscription-based callsites where
// we want the comparison without swapping the consumer's data source.
//
// Opt-in: set `VITE_DATAFEED_SHADOW="1"` to enable the parallel
// datafeed work and comparison logging at module-import time. This
// is a build-time switch — the surrounding hook still runs the legacy
// path normally, so leaving shadow disabled is always safe.
//
// No engine math here. Pure transport-level cross-checks.

type ImportMetaEnv = { VITE_DATAFEED_SHADOW?: string };

function readShadowFlag(): boolean {
  // Production-safe default: shadow comparison is now opt-in because it
  // intentionally opens parallel datafeed requests/subscriptions. That was
  // useful during migration, but it doubles candle/WS work on trader-facing
  // sessions. Set VITE_DATAFEED_SHADOW="1" (or "true") when actively
  // auditing the new datafeed against legacy. Engine math is untouched.
  try {
    const env = (import.meta as unknown as { env?: ImportMetaEnv }).env;
    const raw = env?.VITE_DATAFEED_SHADOW?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return false;
  }
}

export const DATAFEED_SHADOW_ENABLED: boolean = readShadowFlag();

export type MismatchLogger = (name: string, info: unknown) => void;

let logger: MismatchLogger = (name, info) => {
  // Searchable prefix for the migration team to grep across browser
  // console captures and any future log-shipping pipeline.
  // eslint-disable-next-line no-console
  console.warn(`[datafeed-mismatch] ${name}`, info);
};

export function setMismatchLogger(fn: MismatchLogger | null): void {
  logger = fn ?? (() => {});
}

export function logDatafeedMismatch(name: string, info: unknown): void {
  if (!DATAFEED_SHADOW_ENABLED) return;
  logger(name, info);
}

/**
 * Shadow-compares two values from independent data paths and logs when
 * they disagree. Returns `true` on agreement, `false` on disagreement
 * (or when the helper is disabled). Caller decides what to do with
 * the boolean — typically nothing; the value is exposed for tests.
 *
 * `equals` defaults to strict `Object.is`. Most callsites pass a tiny
 * structural comparator (e.g. `(a,b) => a.length === b.length`) since
 * full deep-equality during a chart tick is overkill — what we care
 * about during the observation window is whether the two paths agree
 * on *shape* and *coarse value*, not byte-for-byte.
 *
 * Cold-start safeguard: when EITHER value is `null`/`undefined` (i.e.
 * one path hasn't produced a result yet), the helper returns `true`
 * silently. This mirrors the Phase 1 fix that suppressed bootup
 * mismatch noise. Real divergence only logs once both paths have
 * non-empty data.
 */
export function shadowCompare<T>(
  name: string,
  primary: T | null | undefined,
  legacy: T | null | undefined,
  equals?: (a: T, b: T) => boolean,
): boolean {
  if (!DATAFEED_SHADOW_ENABLED) return true;
  if (primary == null || legacy == null) return true;
  const eq = equals ?? ((a, b) => Object.is(a, b));
  if (eq(primary, legacy)) return true;
  logger(name, { primary, legacy });
  return false;
}
