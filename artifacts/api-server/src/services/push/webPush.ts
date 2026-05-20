import webpush, { type PushSubscription } from "web-push";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pushSubscriptionsTable } from "@workspace/db/schema";
import { logger } from "../../lib/logger";

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  data?: Record<string, unknown>;
}

function vapidPublicKey(): string {
  return (process.env.VAPID_PUBLIC_KEY ?? "").trim();
}

function vapidPrivateKey(): string {
  return (process.env.VAPID_PRIVATE_KEY ?? "").trim();
}

function vapidSubject(): string {
  return (process.env.VAPID_SUBJECT ?? process.env.PUBLIC_APP_URL ?? "mailto:alerts@example.com").trim();
}

let configured = false;

export function isWebPushConfigured(): boolean {
  return !!vapidPublicKey() && !!vapidPrivateKey();
}

export function getVapidPublicKey(): string | null {
  const key = vapidPublicKey();
  return key || null;
}

function ensureConfigured(): boolean {
  if (!isWebPushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(vapidSubject(), vapidPublicKey(), vapidPrivateKey());
    configured = true;
  }
  return true;
}

function toPushSubscription(endpoint: string, keysJson: string): PushSubscription | null {
  try {
    const keys = JSON.parse(keysJson) as { p256dh?: unknown; auth?: unknown };
    if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
    return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  } catch {
    return null;
  }
}

export async function sendWebPushToUser(userId: string, payload: PushPayload): Promise<{ ok: number; failed: number; disabled: boolean }> {
  if (!ensureConfigured()) return { ok: 0, failed: 0, disabled: true };

  const rows = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId));

  let ok = 0;
  let failed = 0;
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    url: payload.url ?? "/alerts",
    data: payload.data ?? {},
  });

  for (const row of rows) {
    const sub = toPushSubscription(row.endpoint, row.keysJson);
    if (!sub) {
      failed += 1;
      continue;
    }
    try {
      await webpush.sendNotification(sub, body, { TTL: 60, urgency: "high" });
      ok += 1;
    } catch (err) {
      failed += 1;
      const statusCode = typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await db
          .delete(pushSubscriptionsTable)
          .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, row.endpoint)));
      } else {
        logger.warn({ err, userId, endpoint: row.endpoint }, "web-push delivery failed");
      }
    }
  }

  return { ok, failed, disabled: false };
}
