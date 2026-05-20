// Phase 3 — `withLegacyFallback` helper, scaffolded here so T3
// (chart/levels/liquidation migration) can adopt it immediately
// without re-inventing the pattern.
//
// Behavioural contract (the part that matters for rollout safety):
//
//   1. If `primary()` throws  → log and return `legacy()` result.
//   2. If `primary()` succeeds and no `equals` is provided
//                            → return primary (legacy is never called).
//   3. If `primary()` succeeds and `equals(primary, legacy) === true`
//                            → return primary.
//   4. If `primary()` succeeds and `equals(primary, legacy) === false`
//                            → log disagreement and **return legacy**
//                              (default), unless `prefer: "primary"` is
//                              set on the call site.
//
// Rule (4) is the safety net: during T3 we don't yet trust the new
// datafeed in production; if it disagrees with legacy we surface the
// legacy answer to users while the disagreement log gives us the data
// to fix it. Call sites that have already been validated can opt back
// into the new path with `prefer: "primary"`, and once T4 deletes
// legacy this whole helper goes away.
//
// Typical call site:
//
//   const value = await withLegacyFallback({
//     name: "fetchCandles:BTC:1H",
//     primary: () => datafeed.fetchCandles({...}),
//     legacy:  () => legacyFetchCandles(...),
//     equals:  (a, b) => a.bars.length === b.bars.length,
//   });
//
// This module is side-effect-free at import time — the logger is
// whatever the app already wires up via `console`. T3 can swap it for
// a structured logger if needed.

export interface LegacyFallbackArgs<T> {
  /** Stable identifier used in disagreement logs. e.g. "fetchCandles:BTC:1H". */
  name: string;
  /** New datafeed call. */
  primary: () => Promise<T>;
  /** Existing call site — invoked when primary throws or for the disagreement check. */
  legacy: () => Promise<T>;
  /** Optional structural compare. When omitted, primary is returned without calling legacy. */
  equals?: (a: T, b: T) => boolean;
  /** Which side wins on disagreement. Default `"legacy"` (safer during T3). */
  prefer?: "legacy" | "primary";
  /** Optional override of the logger. Default: console.warn. */
  log?: (
    kind: "primary-failed" | "disagreement" | "legacy-threw-primary-ok",
    payload: unknown,
  ) => void;
}

const defaultLog: NonNullable<LegacyFallbackArgs<unknown>["log"]> = (
  kind,
  payload,
) => {
  // Keep the prefix searchable so the migration team can grep across
  // production logs once T3 ships.
  // eslint-disable-next-line no-console
  console.warn(`[datafeed:legacyFallback:${kind}]`, payload);
};

export async function withLegacyFallback<T>(args: LegacyFallbackArgs<T>): Promise<T> {
  const log = args.log ?? defaultLog;
  const prefer: "legacy" | "primary" = args.prefer ?? "legacy";

  let primaryValue: T;
  try {
    primaryValue = await args.primary();
  } catch (err) {
    log("primary-failed", { name: args.name, err: String(err) });
    return args.legacy();
  }

  // Primary succeeded. If no compare requested, return immediately —
  // the caller has explicitly opted out of cross-checking.
  if (!args.equals) {
    return primaryValue;
  }

  let legacyValue: T;
  try {
    legacyValue = await args.legacy();
  } catch (err) {
    // Legacy threw but primary succeeded — log so we know the legacy
    // path is starting to bit-rot, then return primary (no other choice).
    log("legacy-threw-primary-ok", { name: args.name, err: String(err) });
    return primaryValue;
  }

  if (args.equals(primaryValue, legacyValue)) {
    return primaryValue;
  }

  log("disagreement", { name: args.name, prefer });
  return prefer === "primary" ? primaryValue : legacyValue;
}
