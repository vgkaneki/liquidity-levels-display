import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { pushSubscriptionsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getUserId } from "../auth/requireAuth";
import { getVapidPublicKey, isWebPushConfigured } from "../services/push/webPush";

const router: IRouter = Router();

// pushRouteInputHardeningV1: push-subscription boundary validation only.
// Protected liquidity/structural level math, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, scanner/reversal scoring, and level
// placement logic are intentionally untouched.
const MAX_ENDPOINT_LEN = 2048;
const MIN_KEY_LEN = 16;
const MAX_KEY_LEN = 4096;
const PUSH_KEY_RE = /^[A-Za-z0-9_-]+={0,2}$/;

function isBlockedEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const octets = host.split(".").map((p) => Number(p));
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

function sanitizeEndpoint(endpoint: unknown): string | null {
  if (typeof endpoint !== "string") return null;
  const value = endpoint.trim();
  if (!value || value.length > MAX_ENDPOINT_LEN) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (isBlockedEndpointHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizePushKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < MIN_KEY_LEN || value.length > MAX_KEY_LEN) return null;
  return PUSH_KEY_RE.test(value) ? value : null;
}

function sanitizeKeys(keys: unknown): { p256dh: string; auth: string } | null {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  const value = keys as { p256dh?: unknown; auth?: unknown };
  const p256dh = sanitizePushKey(value.p256dh);
  const auth = sanitizePushKey(value.auth);
  if (!p256dh || !auth) return null;
  return { p256dh, auth };
}

router.get("/push/vapid-public-key", (_req, res) => {
  res.json({
    enabled: isWebPushConfigured(),
    publicKey: getVapidPublicKey(),
  });
});

router.post("/push/subscribe", async (req, res) => {
  const userId = getUserId(req);
  const { endpoint, keys } = req.body ?? {};
  const cleanEndpoint = sanitizeEndpoint(endpoint);
  if (!cleanEndpoint) {
    res.status(400).json({ error: "valid push endpoint required" });
    return;
  }
  const cleanKeys = sanitizeKeys(keys);
  if (!cleanKeys) {
    res.status(400).json({ error: "valid push keys required" });
    return;
  }

  const existing = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, cleanEndpoint)))
    .limit(1);

  if (existing.length > 0) {
    res.json({ ok: true, duplicate: true, enabled: isWebPushConfigured() });
    return;
  }

  await db.insert(pushSubscriptionsTable).values({
    id: randomUUID(),
    userId,
    endpoint: cleanEndpoint,
    keysJson: JSON.stringify(cleanKeys),
    createdAt: Date.now(),
  });
  res.json({ ok: true, enabled: isWebPushConfigured() });
});

router.post("/push/unsubscribe", async (req, res) => {
  const userId = getUserId(req);
  const { endpoint } = req.body ?? {};
  const cleanEndpoint = sanitizeEndpoint(endpoint);
  if (!cleanEndpoint) {
    res.status(400).json({ error: "valid push endpoint required" });
    return;
  }
  await db
    .delete(pushSubscriptionsTable)
    .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, cleanEndpoint)));
  res.json({ ok: true });
});

export default router;
