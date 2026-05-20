import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { userPreferencesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getUserId } from "../auth/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Allowlist of preference keys the platform is allowed to persist. Any
// key written from the client must match either an exact entry or one
// of the prefix patterns. This is a defense-in-depth layer: even if a
// compromised client tried to dump arbitrary keys, the DB only stores
// the curated platform-state surface.
//
// Keep in sync with the localStorage keys swept by the logout wipe in
// `lib/preferenceSync.tsx`. Both surfaces enforce the same `thermal[.:]`
// namespace.
const ALLOWED_PREFIX = /^thermal[.:]/;
const MAX_KEY_LEN = 128;
// Cap individual blob size so a buggy client can't spend our DB on
// 50MB chartSettings dumps. 64KB is comfortably enough for the
// largest preference object the app produces today (chart settings is
// ~6KB stringified).
const MAX_VALUE_BYTES = 64 * 1024;

function isAllowedKey(k: string): boolean {
  return typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_LEN && ALLOWED_PREFIX.test(k);
}

router.get("/user/preferences", async (req, res) => {
  try {
    const uid = getUserId(req);
    const rows = await db
      .select({
        key: userPreferencesTable.key,
        valueJson: userPreferencesTable.valueJson,
        updatedAt: userPreferencesTable.updatedAt,
      })
      .from(userPreferencesTable)
      .where(eq(userPreferencesTable.userId, uid));
    const preferences: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        preferences[row.key] = JSON.parse(row.valueJson);
      } catch {
        // Skip corrupt entries — never break the whole hydrate over
        // one bad blob.
        logger.warn({ key: row.key, userId: uid }, "user/preferences: corrupt value_json, skipping");
      }
    }
    res.json({ preferences });
  } catch (err) {
    logger.error({ err }, "user/preferences GET failed");
    res.status(500).json({ error: "Failed to load preferences." });
  }
});

router.put("/user/preferences/:key", async (req, res) => {
  try {
    const uid = getUserId(req);
    const key = req.params.key;
    if (!isAllowedKey(key)) {
      res.status(400).json({ error: "Invalid preference key." });
      return;
    }
    const value = req.body?.value;
    // Re-stringify to canonicalize and to detect oversize payloads
    // before they hit the DB.
    let valueJson: string;
    try {
      valueJson = JSON.stringify(value ?? null);
    } catch {
      res.status(400).json({ error: "Value is not JSON-serializable." });
      return;
    }
    if (valueJson.length > MAX_VALUE_BYTES) {
      res.status(413).json({ error: "Preference value too large." });
      return;
    }
    const now = Date.now();
    await db
      .insert(userPreferencesTable)
      .values({ userId: uid, key, valueJson, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferencesTable.userId, userPreferencesTable.key],
        set: { valueJson, updatedAt: now },
      });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "user/preferences PUT failed");
    res.status(500).json({ error: "Failed to save preference." });
  }
});

router.delete("/user/preferences/:key", async (req, res) => {
  try {
    const uid = getUserId(req);
    const key = req.params.key;
    if (!isAllowedKey(key)) {
      res.status(400).json({ error: "Invalid preference key." });
      return;
    }
    await db
      .delete(userPreferencesTable)
      .where(
        and(
          eq(userPreferencesTable.userId, uid),
          eq(userPreferencesTable.key, key),
        ),
      );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "user/preferences DELETE failed");
    res.status(500).json({ error: "Failed to clear preference." });
  }
});

// Suppress the "sql tag declared but unused" lint when conditional
// pruning paths get added later. Touching `sql` here is a noop.
void sql;

export default router;
