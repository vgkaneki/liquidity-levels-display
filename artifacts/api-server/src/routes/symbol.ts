import { Router, type IRouter } from "express";
import * as registry from "../services/symbolRegistry";
import type { DataType } from "../services/symbolRegistry";

const router: IRouter = Router();

const DATA_TYPES: DataType[] = [
  "candles",
  "book",
  "ticker",
  "funding",
  "oi",
  "liquidations",
  "trades",
];

router.get("/symbol/__debug", (_req, res) => {
  const routing: Record<string, unknown> = {};
  for (const dt of DATA_TYPES) routing[dt] = registry._internal_routingFor(dt);
  res.json({
    size: registry.size(),
    snapshotAge: registry.snapshotAge(),
    routing,
  });
});

// Phase 3 (IDatafeed) — symbol discovery surface.
//
// `/symbol/list` returns every symbol known to the registry, optionally
// filtered to those listed on a given exchange. Used by symbol pickers
// and the future TradingView adapter's resolveSymbol/searchSymbols.
//
// `/symbol/search` does a case-insensitive substring match on the
// canonical UI ticker and base asset, capped at 30 results by default
// to keep payloads small (registry has 600+ entries).
//
// Both routes are pure registry reads — no upstream calls, no engine
// state touched. Read-mostly, so a short browser-cache window is fine
// (registry refresh cadence is 60s+ depending on adapter).

const SYMBOL_SEARCH_DEFAULT_LIMIT = 30;
const SYMBOL_SEARCH_MAX_LIMIT = 200;
const SYMBOL_LIST_DEFAULT_LIMIT = 1000;
const SYMBOL_LIST_MAX_LIMIT = 5000;

// symbolRouteInputHardeningV1: route-boundary query/parameter validation only.
// Protected liquidity/structural level math, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, scanner/reversal scoring, and level
// placement logic are intentionally untouched.
const MAX_SYMBOL_QUERY_LEN = 48;
const MAX_SYMBOL_PARAM_LEN = 64;
const SYMBOL_QUERY_RE = /^[A-Z0-9:_./-]{1,48}$/;

const ALLOWED_EXCHANGES = new Set<string>(["hl", "okx", "toobit"]);

function parseLimit(raw: unknown, def: number, max: number): number {
  if (typeof raw !== "string") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function readSymbolQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().toUpperCase();
  if (!q || q.length > MAX_SYMBOL_QUERY_LEN || !SYMBOL_QUERY_RE.test(q)) return null;
  return q;
}

function readSymbolParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const sym = raw.trim().toUpperCase();
  if (!sym || sym.length > MAX_SYMBOL_PARAM_LEN || !SYMBOL_QUERY_RE.test(sym)) return null;
  return sym;
}

router.get("/symbol/list", (req, res) => {
  const exRaw = req.query["exchange"];
  const ex = typeof exRaw === "string" ? exRaw.trim().toLowerCase() : undefined;
  if (ex !== undefined && !ALLOWED_EXCHANGES.has(ex)) {
    res.status(400).json({ error: `unknown exchange: ${ex}` });
    return;
  }
  const limit = parseLimit(req.query["limit"], SYMBOL_LIST_DEFAULT_LIMIT, SYMBOL_LIST_MAX_LIMIT);
  const all = registry.list(ex ? { listed: ex as registry.ExchangeId } : undefined);
  // Sort alphabetically by UI symbol so pagination is stable across calls.
  all.sort((a, b) => a.ui.localeCompare(b.ui));
  const items = all.slice(0, limit);
  res.setHeader("Cache-Control", "public, max-age=15");
  res.json({
    total: all.length,
    count: items.length,
    limit,
    exchange: ex ?? null,
    snapshotAge: registry.snapshotAge(),
    items,
  });
});

router.get("/symbol/search", (req, res) => {
  const q = readSymbolQuery(req.query["q"]);
  const limit = parseLimit(req.query["limit"], SYMBOL_SEARCH_DEFAULT_LIMIT, SYMBOL_SEARCH_MAX_LIMIT);
  if (!q) {
    res.status(400).json({ error: "valid query required: q" });
    return;
  }
  const all = registry.list();
  const matches = all.filter((m) => m.ui.includes(q) || m.base.includes(q));
  // Prefer exact UI / base hits, then prefix matches, then everything
  // else. Ties broken alphabetically so the order is stable.
  matches.sort((a, b) => {
    const score = (m: typeof a): number => {
      if (m.ui === q || m.base === q) return 0;
      if (m.ui.startsWith(q) || m.base.startsWith(q)) return 1;
      return 2;
    };
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.ui.localeCompare(b.ui);
  });
  const items = matches.slice(0, limit);
  res.setHeader("Cache-Control", "public, max-age=15");
  res.json({
    q,
    total: matches.length,
    count: items.length,
    limit,
    items,
  });
});

router.get("/symbol/:sym/debug", (req, res) => {
  const sym = readSymbolParam(req.params.sym);
  if (!sym) {
    res.status(400).json({ error: "valid symbol required" });
    return;
  }
  const meta = registry.resolve(sym);
  if (!meta) {
    res.status(404).json({
      input: sym,
      resolved: null,
      isListedAggregate: registry.isListed(sym),
      snapshotAge: registry.snapshotAge(),
    });
    return;
  }
  const preferred: Record<string, string | null> = {};
  const chains: Record<string, string[]> = {};
  for (const dt of DATA_TYPES) {
    preferred[dt] = registry.preferredFor(meta.ui, dt);
    chains[dt] = registry.fallbackChain(meta.ui, dt);
  }
  res.json({
    input: sym,
    resolved: meta,
    isListedAggregate: registry.isListed(meta.ui),
    preferredFor: preferred,
    fallbackChains: chains,
    snapshotAge: registry.snapshotAge(),
  });
});

export default router;
