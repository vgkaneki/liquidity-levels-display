import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// screenerProxyInputHardeningV1: sidecar proxy input caps only.
// Protected liquidity/structural level math, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, scanner/reversal scoring, and level
// placement logic are intentionally untouched.
const DEFAULT_SIDECAR_PORT = 5000;
const SIDECAR_TIMEOUT_MS = 25_000;
const MAX_CATALOG_QUERY_BYTES = 2048;
const MAX_CATALOG_PARAM_BYTES = 256;
const MAX_SCAN_BODY_BYTES = 64 * 1024;

function parsePort(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_SIDECAR_PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) return DEFAULT_SIDECAR_PORT;
  return n;
}

const SIDECAR_PORT = parsePort(process.env["SCREENER_PORT"]);
const SIDECAR_BASE = `http://127.0.0.1:${SIDECAR_PORT}`;

function readBoundedQuery(req: Request): string | null {
  const qs = new URL(req.url, "http://localhost").search;
  if (qs.length > MAX_CATALOG_QUERY_BYTES) return null;
  const params = new URLSearchParams(qs);
  for (const [key, value] of params.entries()) {
    if (key.length > MAX_CATALOG_PARAM_BYTES || value.length > MAX_CATALOG_PARAM_BYTES) return null;
  }
  return qs;
}

function stringifyBoundedBody(raw: unknown): string | null {
  try {
    const body = JSON.stringify(raw ?? {});
    if (body.length > MAX_SCAN_BODY_BYTES) return null;
    return body;
  } catch {
    return null;
  }
}

async function proxyJson(
  req: Request,
  res: Response,
  upstreamPath: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const url = `${SIDECAR_BASE}${upstreamPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? SIDECAR_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.type(ct);
    res.send(text);
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "screener sidecar timeout"
        : "screener sidecar unreachable";
    logger.warn({ err, url }, "screener proxy error");
    res.status(503).json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
}

router.get("/screener/health", (req, res) => {
  void proxyJson(req, res, "/api/health", { method: "GET", timeoutMs: 3_000 });
});

router.get("/screener/catalog", (req, res) => {
  const qs = readBoundedQuery(req);
  if (qs === null) {
    res.status(400).json({ ok: false, error: "catalog query too large" });
    return;
  }
  void proxyJson(req, res, `/api/catalog${qs}`, { method: "GET", timeoutMs: 5_000 });
});

router.post("/screener/scan", (req, res) => {
  const body = stringifyBoundedBody(req.body);
  if (body === null) {
    res.status(400).json({ ok: false, error: "scan payload too large" });
    return;
  }
  void proxyJson(req, res, "/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeoutMs: 60_000,
  });
});

export default router;
