// HL Validation HTTP routes. All paths are non-blocking — actual work
// runs in the in-process job manager.
//
// VALIDATION-ONLY. Mounted under /api/liquidity/hl-validation.
// Auth-gated by the /api requireAuth middleware in app.ts.

import { Router, type IRouter, type Request, type Response } from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { hlValidationJobs, hlValidationForwardJobs, isProfileName } from "../services/hlValidation";

const router: IRouter = Router();

// hlValidationRouteInputHardeningV1: route-boundary caps for validation jobs.
const RUN_ID_RE = /^[A-Za-z0-9-]{4,64}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const INTERVAL_RE = /^(1m|3m|5m|15m|30m|1h|2h|4h|8h|12h|1d)$/;
const MAX_FORWARD_SYMBOLS = 12;
const MAX_FORWARD_INTERVALS = 8;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5 * 60_000;

function paramId(req: Request): string {
  const v = req.params.runId;
  const raw = typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : "";
  const id = raw.trim();
  return RUN_ID_RE.test(id) ? id : "";
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  const n = boundedNumber(value, min, max);
  return typeof n === "number" ? Math.trunc(n) : undefined;
}

function listOfStrings(value: unknown, re: RegExp, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!re.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

function safeServeFile(res: Response, p: string | undefined): void {
  if (!p || !existsSync(p)) { res.status(404).json({ error: "report not found" }); return; }
  const ext = extname(p).toLowerCase();
  const ct = ext === ".md" ? "text/markdown; charset=utf-8" : ext === ".csv" ? "text/csv" : "application/octet-stream";
  res.setHeader("Content-Type", ct);
  res.setHeader("Content-Length", String(statSync(p).size));
  res.setHeader("Content-Disposition", `attachment; filename="${p.split("/").pop()}"`);
  res.send(readFileSync(p));
}

// ── Historical ────────────────────────────────────────────────────

router.post("/liquidity/hl-validation/start", (req: Request, res: Response): void => {
  const body = (req.body ?? {}) as { profile?: unknown; minRiskBps?: unknown; maxCostToRiskRatio?: unknown };
  const profile = body.profile;
  if (!isProfileName(profile)) { res.status(400).json({ error: "profile must be smoke|quick|standard|full" }); return; }
  const overrides: { minRiskBps?: number; maxCostToRiskRatio?: number } = {};
  const minRiskBps = boundedNumber(body.minRiskBps, 0, 10_000);
  const maxCostToRiskRatio = boundedNumber(body.maxCostToRiskRatio, 0.01, 100);
  if (typeof minRiskBps === "number") overrides.minRiskBps = minRiskBps;
  if (typeof maxCostToRiskRatio === "number") overrides.maxCostToRiskRatio = maxCostToRiskRatio;
  const status = hlValidationJobs.start(profile, overrides);
  res.status(202).json(status);
});

router.get("/liquidity/hl-validation/status/:runId", (req: Request, res: Response): void => {
  const s = hlValidationJobs.get(paramId(req));
  if (!s) { res.status(404).json({ error: "unknown runId" }); return; }
  res.json(s);
});

router.get("/liquidity/hl-validation/report/:runId", (req: Request, res: Response): void => {
  const s = hlValidationJobs.get(paramId(req));
  if (!s) { res.status(404).json({ error: "unknown runId" }); return; }
  if (!s.reportPath) { res.status(409).json({ error: `report not yet ready (phase=${s.phase})` }); return; }
  safeServeFile(res, s.reportPath);
});

router.get("/liquidity/hl-validation/runs", (_req: Request, res: Response): void => {
  res.json({ runs: hlValidationJobs.list(10) });
});

router.post("/liquidity/hl-validation/cancel/:runId", (req: Request, res: Response): void => {
  const ok = hlValidationJobs.cancel(paramId(req));
  if (!ok) { res.status(404).json({ error: "unknown or already-finished runId" }); return; }
  res.json({ ok: true });
});

// ── Forward paper mode ────────────────────────────────────────────

router.post("/liquidity/hl-validation/forward/start", (req: Request, res: Response): void => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = hlValidationForwardJobs.start({
    symbols: listOfStrings(body.symbols, SYMBOL_RE, MAX_FORWARD_SYMBOLS),
    intervals: listOfStrings(body.intervals, INTERVAL_RE, MAX_FORWARD_INTERVALS),
    durationMs: boundedInteger(body.durationMs, 60_000, MAX_DURATION_MS),
    pollMs: boundedInteger(body.pollMs, MIN_POLL_MS, MAX_POLL_MS),
    tpR: boundedNumber(body.tpR, 0.1, 10),
    slAtrMult: boundedNumber(body.slAtrMult, 0.1, 10),
    timeoutBars: boundedInteger(body.timeoutBars, 1, 500),
    feeBps: boundedNumber(body.feeBps, 0, 1_000),
    slippageBps: boundedNumber(body.slippageBps, 0, 1_000),
  });
  res.status(202).json(status);
});

router.get("/liquidity/hl-validation/forward/status/:runId", (req: Request, res: Response): void => {
  const s = hlValidationForwardJobs.get(paramId(req));
  if (!s) { res.status(404).json({ error: "unknown runId" }); return; }
  res.json(s);
});

router.post("/liquidity/hl-validation/forward/cancel/:runId", (req: Request, res: Response): void => {
  const ok = hlValidationForwardJobs.cancel(paramId(req));
  if (!ok) { res.status(404).json({ error: "unknown or already-finished runId" }); return; }
  res.json({ ok: true });
});

router.get("/liquidity/hl-validation/forward/report/:runId", (req: Request, res: Response): void => {
  const s = hlValidationForwardJobs.get(paramId(req));
  if (!s) { res.status(404).json({ error: "unknown runId" }); return; }
  if (!s.reportPath) { res.status(409).json({ error: `report not yet ready (phase=${s.phase})` }); return; }
  safeServeFile(res, s.reportPath);
});

export default router;
