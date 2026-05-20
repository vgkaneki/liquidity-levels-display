// SymbolRegistry — single source of truth for symbol normalization,
// listing detection, exchange-native mapping, and routing decisions.
//
// Phase 1 design:
//   - Hardcoded routing constants in routing.ts, env-overridable per
//     data type (CANDLES_ROUTING, BOOK_ROUTING, ...).
//   - HL / OKX / Toobit listing adapters (Binance & Bybit deferred).
//   - Per-adapter snapshots refreshed on a TTL timer; merged into a
//     unified Map<ui, SymbolMeta> after every refresh.
//   - Migration safety: callers wrap legacy converters with this
//     registry and log structured `[symbol-registry-mismatch]` warns
//     when answers diverge. The legacy code paths are removed in a
//     follow-up release once the logs are clean.

import { logger } from "../../lib/logger";
import { hlAdapter } from "./adapters/hl";
import { okxAdapter } from "./adapters/okx";
import { toobitAdapter } from "./adapters/toobit";
import { mergeSnapshots } from "./merge";
import { getRoutingChain } from "./routing";
import {
  ALL_EXCHANGES,
  type AdapterSnapshot,
  type DataType,
  type ExchangeId,
  type Listing,
  type SymbolAdapter,
  type SymbolMeta,
} from "./types";

export type { ExchangeId, DataType, Listing, SymbolMeta };

// renderRuntimePressureV1: Toobit registry refresh is optional on Render.
// In production logs it repeatedly returned null and added noisy retries while
// HL/OKX already supplied the active chart universe. Opt in with
// ENABLE_TOOBIT_SYMBOL_REGISTRY=1 when Toobit is healthy/needed. Routing still
// remains safe: disabled/missing snapshots resolve as unknown, not false 404s.
const ENABLE_TOOBIT_SYMBOL_REGISTRY = process.env["ENABLE_TOOBIT_SYMBOL_REGISTRY"] === "1";
const ADAPTERS: SymbolAdapter[] = ENABLE_TOOBIT_SYMBOL_REGISTRY
  ? [hlAdapter, okxAdapter, toobitAdapter]
  : [hlAdapter, okxAdapter];
const ACTIVE_EXCHANGES = new Set<ExchangeId>(ADAPTERS.map((a) => a.exchange));

// A snapshot older than this falls back to "unknown" for the absent-
// symbol case. Long enough to ride out one or two failed refreshes
// without false-negativing real listings.
const GLOBAL_STALE_MS = 10 * 60_000;

const snapshots: Partial<Record<ExchangeId, AdapterSnapshot>> = {};
let merged: Map<string, SymbolMeta> = new Map();
// Reverse maps: native exchange symbol → UI symbol. Built once per
// rebuild so hot paths (e.g. okx-ws.fromInstId on every market message)
// don't pay an O(N) scan per call. Keyed by exchange.
const reverseByExchange: Record<ExchangeId, Map<string, string>> = {
  hl: new Map(),
  okx: new Map(),
  toobit: new Map(),
};
let started = false;
const refreshTimers: NodeJS.Timeout[] = [];

function rebuild(): void {
  merged = mergeSnapshots(snapshots, GLOBAL_STALE_MS);
  for (const ex of ALL_EXCHANGES) reverseByExchange[ex].clear();
  for (const meta of merged.values()) {
    for (const ex of ALL_EXCHANGES) {
      const native = meta.native[ex];
      if (native) reverseByExchange[ex].set(native, meta.ui);
    }
  }
}

async function refreshOne(adapter: SymbolAdapter): Promise<void> {
  try {
    const records = await adapter.fetch();
    snapshots[adapter.exchange] = {
      exchange: adapter.exchange,
      records,
      fetchedAt: Date.now(),
      ok: true,
    };
    logger.info(
      { exchange: adapter.exchange, count: records.length },
      "symbolRegistry: snapshot refreshed",
    );
  } catch (err) {
    const prev = snapshots[adapter.exchange];
    snapshots[adapter.exchange] = {
      exchange: adapter.exchange,
      records: prev?.records ?? [],
      fetchedAt: prev?.fetchedAt ?? 0,
      ok: false,
    };
    logger.warn(
      { exchange: adapter.exchange, err: String(err) },
      "symbolRegistry: snapshot refresh failed",
    );
  }
  rebuild();
}

function startRefreshLoop(adapter: SymbolAdapter): void {
  const t = setInterval(() => {
    void refreshOne(adapter);
  }, adapter.ttlMs);
  t.unref();
  refreshTimers.push(t);
}

// Cold-boot fast-retry: if an adapter's first eager fetch failed (e.g.
// HL 429 during a noisy restart), the next sample is a full TTL away
// (60s for HL, 5m for OKX). Retry every 5s for up to 60s after start
// so the snapshot fills in quickly rather than leaving symbols in
// "unknown" state. Only fires while the snapshot is missing/!ok.
function startColdRetry(adapter: SymbolAdapter): void {
  const startedAt = Date.now();
  const RETRY_INTERVAL_MS = 5_000;
  const RETRY_WINDOW_MS = 60_000;
  const tick = (): void => {
    const snap = snapshots[adapter.exchange];
    if (snap?.ok) return;
    if (Date.now() - startedAt > RETRY_WINDOW_MS) return;
    void refreshOne(adapter).then(() => {
      const after = snapshots[adapter.exchange];
      if (!after?.ok) {
        const t = setTimeout(tick, RETRY_INTERVAL_MS);
        t.unref();
      }
    });
  };
  const t = setTimeout(tick, RETRY_INTERVAL_MS);
  t.unref();
}

/**
 * Idempotent. Eager parallel fetch with a soft ceiling — any adapter
 * that misses the window starts as "unknown" and fills in on its first
 * interval tick. Background refresh timers are installed for every
 * adapter (timer.unref()'d so they never block process exit).
 */
export async function start(opts?: { eagerCeilingMs?: number }): Promise<void> {
  if (started) return;
  started = true;
  const ceilingMs = opts?.eagerCeilingMs ?? 3_000;
  const tasks = ADAPTERS.map((a) => refreshOne(a));
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((r) => setTimeout(r, ceilingMs)),
  ]);
  for (const a of ADAPTERS) {
    startRefreshLoop(a);
    if (!snapshots[a.exchange]?.ok) startColdRetry(a);
  }
  logger.info(
    {
      size: merged.size,
      eagerCeilingMs: ceilingMs,
      adapters: Object.fromEntries(
        ALL_EXCHANGES.map((ex) => [
          ex,
          ACTIVE_EXCHANGES.has(ex) ? !!snapshots[ex]?.ok : "disabled",
        ]),
      ),
    },
    "symbolRegistry: started",
  );
}

function normUi(s: string): string {
  return s.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

/** Resolve an arbitrary symbol form to its canonical SymbolMeta. */
export function resolve(ui: string): SymbolMeta | null {
  const k = normUi(ui);
  if (!k) return null;
  const direct = merged.get(k);
  if (direct) return direct;
  if (!k.endsWith("USDT")) {
    const withQuote = `${k}USDT`;
    const m = merged.get(withQuote);
    if (m) return m;
  }
  return null;
}

/** Returns null if the symbol isn't listed on `ex` (or registry doesn't know). */
export function toNative(ui: string, ex: ExchangeId): string | null {
  const m = resolve(ui);
  return m?.native[ex] ?? null;
}

/** Reverse-lookup a native exchange symbol back to the canonical UI form. */
export function fromNative(native: string, ex: ExchangeId): string | null {
  return reverseByExchange[ex].get(native) ?? null;
}

function allFresh(): boolean {
  const now = Date.now();
  for (const ex of ACTIVE_EXCHANGES) {
    const s = snapshots[ex];
    if (!s || !s.ok) return false;
    if (now - s.fetchedAt >= GLOBAL_STALE_MS) return false;
  }
  return true;
}

/** Per-exchange or aggregate listing. Aggregate = "yes" if any "yes". */
export function isListed(ui: string, ex?: ExchangeId): Listing {
  const m = resolve(ui);
  if (!m) {
    return allFresh() ? "no" : "unknown";
  }
  if (ex) return m.listed[ex];
  const vals = Object.values(m.listed);
  if (vals.includes("yes")) return "yes";
  if (vals.every((v) => v === "no")) return "no";
  return "unknown";
}

/**
 * Decide if `ui` is *definitively unsupported* for the given data type.
 * Used by the candles route to fast-path a 404 instead of walking the
 * full upstream ladder (HL → OKX → Toobit) just to learn no exchange
 * has the pair, which previously emitted a 3.7s 503 and triggered a
 * react-query retry storm.
 *
 * Discriminated semantics, per the production-fix spec:
 *  - returns `true` ONLY on positive evidence of unsupport.
 *  - returns `false` whenever the answer might still be transient
 *    upstream error, throttle, or unknown — those must NOT be cached
 *    as 404. They fall through to the regular ladder and surface as
 *    503 if they fail there.
 *
 * Two cases:
 *
 *  (a) Symbol IS in the merged registry. Defer to `isListed`'s
 *      aggregate semantics: all exchanges in `m.listed` must say "no".
 *      This is independent of snapshot freshness because we are
 *      reading registry state we already have, and crucially this
 *      preserves the pre-fix behavior for symbols that ARE listed on
 *      a fallback exchange the routing chain doesn't advertise (e.g.
 *      OKX-only symbols where the candles routing chain is HL → Toobit
 *      but the route still has an OKX fallback at runtime).
 *
 *  (b) Symbol is NOT in the merged registry. Require the data type's
 *      routing chain to be fresh+ok before asserting unsupport. This
 *      replaces the previous `allFresh()` global gate which was kept
 *      permanently false by any single throttled/erroring exchange,
 *      silently bypassing this fast-path. Chain-scoping it means
 *      unrelated exchanges (e.g. liquidations adapters) can't mask
 *      the decision, but the chain itself must be authoritative.
 *
 * No engine math, scoring, confluence, precision, regime,
 * touch/confirmation, registry decay, or level generation logic is
 * touched — this is purely a status-decision READ.
 */
export function isUnsupportedFor(ui: string, dt: DataType): boolean {
  const m = resolve(ui);
  if (m) {
    return Object.values(m.listed).every((v) => v === "no");
  }
  const chain = getRoutingChain(dt);
  if (chain.length === 0) return false;
  const now = Date.now();
  for (const ex of chain) {
    const s = snapshots[ex];
    if (!s || !s.ok) return false;
    if (now - s.fetchedAt >= GLOBAL_STALE_MS) return false;
  }
  return true;
}

/** First exchange in the data-type's routing chain that lists this symbol. */
export function preferredFor(ui: string, dt: DataType): ExchangeId | null {
  const chain = getRoutingChain(dt);
  for (const ex of chain) {
    if (isListed(ui, ex) === "yes") return ex;
  }
  return null;
}

/** All listed exchanges in routing-priority order. */
export function fallbackChain(ui: string, dt: DataType): ExchangeId[] {
  const chain = getRoutingChain(dt);
  return chain.filter((ex) => isListed(ui, ex) === "yes");
}

export interface ListFilter {
  listed?: ExchangeId;
  quote?: string;
}

export function list(filter?: ListFilter): SymbolMeta[] {
  const out: SymbolMeta[] = [];
  for (const m of merged.values()) {
    if (filter?.listed && m.listed[filter.listed] !== "yes") continue;
    if (filter?.quote && m.quote !== filter.quote) continue;
    out.push(m);
  }
  return out;
}

export function snapshotAge(): Record<
  ExchangeId,
  { lastFetchAt: number; ageMs: number; ok: boolean }
> {
  const now = Date.now();
  const out: Partial<
    Record<ExchangeId, { lastFetchAt: number; ageMs: number; ok: boolean }>
  > = {};
  for (const ex of ALL_EXCHANGES) {
    const s = snapshots[ex];
    out[ex] = {
      lastFetchAt: s?.fetchedAt ?? 0,
      ageMs: s ? now - s.fetchedAt : -1,
      ok: !!s?.ok,
    };
  }
  return out as Record<
    ExchangeId,
    { lastFetchAt: number; ageMs: number; ok: boolean }
  >;
}

export function size(): number {
  return merged.size;
}

/** Diagnostic helper exposed for the debug route. */
export function _internal_routingFor(dt: DataType): ExchangeId[] {
  return getRoutingChain(dt);
}
