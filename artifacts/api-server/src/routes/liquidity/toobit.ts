// Toobit Phase-B routes (read-only).
//
// All routes are mounted ONLY when `toobitEnabled()` returns true at server
// boot, AND every request additionally passes through `toobitGate` for
// per-request jurisdiction enforcement.

import { Router, type IRouter } from "express";
import { toobitGate } from "../../middlewares/toobitGate";
import {
  ensureSubscribed,
  getToobitBook,
  getToobitTicker,
  getToobitWsHealth,
  isToobitSupported,
  listUniverse,
} from "./exchanges/toobit-ws";
import { fetchDepthSnapshot, fetchKlines } from "./exchanges/toobit";

const router: IRouter = Router();

// Path-scope the jurisdiction gate to ONLY the Toobit liquidity surface.
// Without the path filter the gate runs for every request that reaches
// this router via the parent's `router.use(toobitRouter)` mount, which
// in turn intercepts unrelated endpoints (watchlists, alerts, symbol
// list, etc.) when an earlier router doesn't match — producing the
// production "jurisdiction_blocked for /api/watchlists" regression.
// The jurisdiction policy itself is unchanged; only its scope.
router.use("/liquidity/toobit", toobitGate);

router.get("/liquidity/toobit/health", (_req, res): void => {
  res.json(getToobitWsHealth());
});

router.get("/liquidity/toobit/symbols", (_req, res): void => {
  res.json({ symbols: listUniverse() });
});

router.get("/liquidity/toobit/ticker", (req, res): void => {
  const sym = String(req.query.symbol || "").toUpperCase();
  if (!sym) { res.status(400).json({ ok: false, error: "symbol required" }); return; }
  if (!isToobitSupported(sym)) {
    res.status(404).json({ ok: false, error: "symbol not in Toobit USDT-perp universe" });
    return;
  }
  ensureSubscribed(sym);
  const t = getToobitTicker(sym);
  if (!t) {
    // First touch: WS subscribe was just sent; client should retry.
    res.status(202).json({ ok: false, code: "warming_up", error: "subscribed; data not yet received" });
    return;
  }
  res.json({ symbol: sym, exchange: "toobit", ...t });
});

router.get("/liquidity/toobit/orderbook", async (req, res): Promise<void> => {
  const sym = String(req.query.symbol || "").toUpperCase();
  const depth = Math.min(200, Math.max(5, parseInt(String(req.query.depth || "100"), 10) || 100));
  if (!sym) { res.status(400).json({ ok: false, error: "symbol required" }); return; }
  if (!isToobitSupported(sym)) {
    res.status(404).json({ ok: false, error: "symbol not in Toobit USDT-perp universe" });
    return;
  }
  ensureSubscribed(sym);
  const ws = getToobitBook(sym);
  if (ws && ws.bids.length > 0 && ws.asks.length > 0) {
    res.json({
      symbol: sym, exchange: "toobit", source: "ws",
      bids: ws.bids.slice(0, depth), asks: ws.asks.slice(0, depth),
      ts: ws.ts,
    });
    return;
  }
  // Cold-start snapshot via REST. Subsequent reads come from WS.
  const universe = listUniverse().find((u) => u.uiSymbol === sym);
  if (!universe) { res.status(404).json({ ok: false, error: "symbol not resolvable" }); return; }
  const snap = await fetchDepthSnapshot(universe.symbol, depth);
  if (!snap) {
    res.status(503).json({ ok: false, code: "snapshot_unavailable", error: "Toobit REST snapshot unavailable" });
    return;
  }
  res.json({ symbol: sym, exchange: "toobit", source: "rest", bids: snap.bids, asks: snap.asks });
});

router.get("/liquidity/toobit/candles", async (req, res): Promise<void> => {
  const sym = String(req.query.symbol || "").toUpperCase();
  const interval = String(req.query.interval || "1h");
  const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || "200"), 10) || 200));
  if (!sym) { res.status(400).json({ ok: false, error: "symbol required" }); return; }
  const universe = listUniverse().find((u) => u.uiSymbol === sym);
  if (!universe) {
    res.status(404).json({ ok: false, error: "symbol not in Toobit USDT-perp universe" });
    return;
  }
  const candles = await fetchKlines(universe.symbol, interval, limit);
  if (!candles) {
    res.status(503).json({ ok: false, code: "backfill_unavailable", error: "Toobit REST backfill unavailable" });
    return;
  }
  res.json({ symbol: sym, exchange: "toobit", interval, candles });
});

export default router;
