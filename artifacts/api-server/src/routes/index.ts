import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import liquidityRouter from "./liquidity";
import screenerRouter from "./screener";
import watchlistsRouter from "./watchlists";
import alertsRouter from "./alerts";
import pushRouter from "./push";
import levelsRouter from "./levels";
import symbolRouter from "./symbol";
import userPreferencesRouter from "./userPreferences";
import hlValidationRouter from "./hlValidation";
import { normalizeCoin, normalizeInterval, denormalizePerpSymbol } from "../services/levelsHost";
import { levelRegistry } from "../services/levelRegistry";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Host adapter for the canonical horizontal-levels engine. The engine's
// route file (`./levels.ts`) is preserved byte-for-byte and expects HL-style
// inputs (`coin: "BTC"`, lowercase intervals like `"4h"`). The rest of the
// app speaks chart-native perp symbols (`"BTCUSDT"`) and uppercase
// intervals (`"4H"`). This middleware translates inbound query params at
// the boundary, then wraps `res.json` so a successful compute also feeds
// the level registry — which the legacy orchestrator did inline but the
// standalone engine does not know about.
function levelsHostMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path !== "/levels") return next();

  // Express 5 exposes `req.query` as a getter parsed lazily from `req.url`,
  // so mutating `req.query` directly does not persist. Rewrite the URL's
  // query string instead — the getter re-parses on next access.
  const url = new URL(req.url, "http://internal");
  const rawSymbol = url.searchParams.get("symbol") ?? "";
  const rawInterval = url.searchParams.get("interval") ?? "";
  let mutated = false;
  if (rawSymbol) {
    const coin = normalizeCoin(rawSymbol);
    url.searchParams.set("symbol", coin);
    res.locals.levelsPerpSymbol = denormalizePerpSymbol(coin);
    mutated = true;
  }
  if (rawInterval) {
    url.searchParams.set("interval", normalizeInterval(rawInterval));
    mutated = true;
  }
  if (mutated) req.url = url.pathname + url.search;

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    try {
      const perpSym = res.locals.levelsPerpSymbol as string | undefined;
      // CRITICAL: Skip the registry feed when the response is the
      // route-level last-good fallback (`stale: true` payload from
      // routes/levels.ts catch path). Otherwise every poll during an
      // upstream outage re-feeds the SAME stale zones through
      // recordZones — which treats them as fresh confirmations
      // (touches+=1, lastConfirmedAt=now, EMA blends toward same
      // score) and prevents the legitimate time-decay of zones that
      // should be aging out. The result is a registry contaminated
      // with re-confirmed snapshots from the outage window.
      const isStaleFallback =
        body && typeof body === "object" && (body as { stale?: unknown }).stale === true;
      // Same rationale as the stale-fallback skip: an SWR fast-path
      // response (`X-Levels-SWR: fresh-lastgood`) is the route serving
      // a cached snapshot from `levelsLastGood`, NOT a fresh compute.
      // Re-feeding it through recordZones would treat the cached zones
      // as a brand-new confirmation every 45s on hot symbols, biasing
      // touches/decay/EMA dynamics in the registry. Skip it. The
      // background refresh kicked off by the SWR path will compute
      // fresh zones, and THAT response (when served) carries no
      // SWR header and will be ingested normally.
      const isSwrCached = res.getHeader("X-Levels-SWR") === "fresh-lastgood";
      if (
        perpSym &&
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        !isStaleFallback &&
        !isSwrCached &&
        body && typeof body === "object" &&
        Array.isArray((body as { zones?: unknown }).zones)
      ) {
        levelRegistry.recordZones(
          perpSym,
          (body as { zones: Parameters<typeof levelRegistry.recordZones>[1] }).zones,
        );
      }
    } catch (e) {
      logger.warn({ err: e }, "levelRegistry.recordZones (route hook) failed");
    }
    return originalJson(body);
  }) as Response["json"];

  next();
}

router.use(healthRouter);
// HL Validation routes are mounted BEFORE the heavy liquidity router and
// BEFORE the levelsHostMiddleware so the middleware never sees their
// query params (it filters on req.path === "/levels"; mounting order
// here is purely defensive). The validation suite is sealed from the
// live engine and never feeds the registry.
router.use(hlValidationRouter);
router.use(liquidityRouter);
router.use(screenerRouter);
router.use(watchlistsRouter);
router.use(alertsRouter);
router.use(pushRouter);
router.use(symbolRouter);
router.use(userPreferencesRouter);
router.use(levelsHostMiddleware);
router.use(levelsRouter);

export default router;
