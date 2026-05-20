import {
  ALL_EXCHANGES,
  type AdapterSnapshot,
  type ExchangeId,
  type SymbolMeta,
} from "./types";

/**
 * Merge per-exchange snapshots into a unified symbol map keyed by UI form.
 *
 * Listing semantics, per (symbol, exchange):
 *   - "yes"     : symbol IS in this exchange's snapshot.
 *   - "no"      : symbol is NOT in this exchange's snapshot AND the
 *                 snapshot is fresh (within `staleAfterMs` and ok).
 *   - "unknown" : snapshot is stale, missing, or last fetch failed.
 */
export function mergeSnapshots(
  snapshots: Partial<Record<ExchangeId, AdapterSnapshot>>,
  staleAfterMs: number,
): Map<string, SymbolMeta> {
  const now = Date.now();
  const out = new Map<string, SymbolMeta>();

  const fresh: Record<ExchangeId, boolean> = {
    hl: false,
    okx: false,
    toobit: false,
  };
  for (const ex of ALL_EXCHANGES) {
    const snap = snapshots[ex];
    fresh[ex] = !!snap && snap.ok && now - snap.fetchedAt < staleAfterMs;
  }

  for (const ex of ALL_EXCHANGES) {
    const snap = snapshots[ex];
    if (!snap || !snap.ok) continue;
    for (const r of snap.records) {
      let meta = out.get(r.ui);
      if (!meta) {
        meta = {
          ui: r.ui,
          base: r.base,
          quote: r.quote,
          native: {},
          listed: { hl: "unknown", okx: "unknown", toobit: "unknown" },
        };
        out.set(r.ui, meta);
      }
      meta.native[ex] = r.native;
      meta.listed[ex] = "yes";
    }
  }

  for (const meta of out.values()) {
    for (const ex of ALL_EXCHANGES) {
      if (meta.listed[ex] === "yes") continue;
      meta.listed[ex] = fresh[ex] ? "no" : "unknown";
    }
  }

  return out;
}
