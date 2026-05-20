import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { alertRulesTable, alertHistoryTable, alertDeliveriesTable, alertMutesTable, watchlistsTable } from "@workspace/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { manualFire, deleteRuleRuntime, refreshMuteCache } from "../services/alertEngine";
import { getUserId } from "../auth/requireAuth";
import { ensureUserDefaultWatchlist } from "../services/watchlistSeed";

const router: IRouter = Router();

const VALID_KINDS = new Set(["price_above", "price_below", "level_touch", "tier_change", "funding_flip"]);
const VALID_SINKS = new Set(["toast", "webhook", "discord", "push"]);

// alertRouteInputHardeningV1: API-boundary validation and SSRF reduction for
// user-supplied alert route inputs only. Protected liquidity/structural level
// math, confluence/scoring, DOM/Bookmap, absorption, touch classification,
// scanner scoring, reversal scoring, and level placement logic are untouched.
const MAX_ALERT_NAME_LEN = 96;
const MAX_SYMBOL_LEN = 32;
const MAX_WATCHLIST_SCOPE_LEN = 96;
const MAX_ID_LEN = 128;
const MAX_PARAMS_JSON_BYTES = 16 * 1024;
const MAX_SINKS = 4;
const MAX_URL_LEN = 2048;
const MAX_HISTORY_LIMIT = 200;
const MAX_MUTE_DURATION_MS = 24 * 60 * 60_000;
const MIN_MUTE_DURATION_MS = 60_000;
const CONCRETE_SYMBOL_RE = /^[A-Z0-9]{2,32}$/;
const WATCHLIST_SCOPE_RE = /^[A-Za-z0-9._:-]{1,96}$/;

// Symbols are normalized server-side. A rule may scope to:
//   - a canonical concrete symbol (e.g. "BTCUSDT" — dashes dropped, uppercased)
//   - "*" (every symbol seen by the engine)
//   - "watchlist:<id>" (resolved at eval time to that list's members)
function canonicalize(symbol: string): string {
  if (symbol === "*") return "*";
  if (symbol.startsWith("watchlist:")) return symbol; // pass-through scope token
  return symbol.replace(/-/g, "").toUpperCase();
}

function cleanId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > MAX_ID_LEN) return null;
  return id;
}

function readAlertName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_ALERT_NAME_LEN) return null;
  return name;
}

function readAlertSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > Math.max(MAX_SYMBOL_LEN, "watchlist:".length + MAX_WATCHLIST_SCOPE_LEN)) return null;
  if (value === "*") return "*";
  if (value.startsWith("watchlist:")) {
    const id = value.slice("watchlist:".length).trim();
    if (!id || id.length > MAX_WATCHLIST_SCOPE_LEN || !WATCHLIST_SCOPE_RE.test(id)) return null;
    return `watchlist:${id}`;
  }
  const canonical = canonicalize(value);
  return CONCRETE_SYMBOL_RE.test(canonical) ? canonical : null;
}

function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function isBlockedWebhookHost(hostname: string): boolean {
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

function parseWebhookUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LEN) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (isBlockedWebhookHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isDiscordWebhookUrl(raw: unknown): boolean {
  const url = parseWebhookUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const allowedHost = host === "discord.com" || host === "discordapp.com" || host === "ptb.discord.com" || host === "canary.discord.com";
  return allowedHost && /^\/api(?:\/v\d+)?\/webhooks\//i.test(url.pathname);
}

function safeParams(raw: unknown): Record<string, unknown> | null {
  const params = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  try {
    const serialized = JSON.stringify(params);
    if (serialized.length > MAX_PARAMS_JSON_BYTES) return null;
  } catch {
    return null;
  }
  return params;
}

// IDOR guard for any per-rule mutation. Loads the rule only if it
// belongs to the authenticated user; returns null otherwise so the
// handler can 404.
async function loadOwnedRule(userId: string, ruleId: string) {
  const rows = await db
    .select()
    .from(alertRulesTable)
    .where(and(eq(alertRulesTable.id, ruleId), eq(alertRulesTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// Resolve a rule's symbol scope, enforcing ownership of any
// `watchlist:<id>` reference. Without this check a user could craft a
// rule with `watchlist:<some-other-user's-id>` and the engine would
// happily evaluate it against that user's watchlist members — leaking
// the membership list and letting one user piggy-back on another's
// curated symbol set. Concrete symbol scopes ("BTCUSDT", "*") pass
// through unchanged. The "watchlist:default" alias is rewritten to
// the requesting user's own default watchlist id.
async function resolveSymbolScope(
  userId: string,
  symbol: string,
): Promise<{ ok: true; symbol: string } | { ok: false; error: string }> {
  if (!symbol.startsWith("watchlist:")) return { ok: true, symbol };
  const id = symbol.slice("watchlist:".length).trim();
  if (!id) return { ok: false, error: "watchlist scope requires an id" };
  const realId = id === "default" ? await ensureUserDefaultWatchlist(userId) : id;
  const owned = await db
    .select({ id: watchlistsTable.id })
    .from(watchlistsTable)
    .where(and(eq(watchlistsTable.id, realId), eq(watchlistsTable.userId, userId)))
    .limit(1);
  if (!owned[0]) return { ok: false, error: "watchlist not found" };
  return { ok: true, symbol: `watchlist:${realId}` };
}

router.get("/alerts/rules", async (req, res) => {
  const uid = getUserId(req);
  const rows = await db
    .select()
    .from(alertRulesTable)
    .where(eq(alertRulesTable.userId, uid));
  res.json({
    rules: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      symbol: r.symbol,
      params: safeJson(r.paramsJson, {}),
      sinks: safeJson(r.sinksJson, ["toast"]),
      throttleMs: r.throttleMs,
      enabled: r.enabled,
      createdAt: r.createdAt,
    })),
  });
});

router.post("/alerts/rules", async (req, res) => {
  const uid = getUserId(req);
  const body = req.body ?? {};
  const validation = validateRule(body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { name, kind, symbol, params, sinks, throttleMs, enabled } = validation.value;
  const scoped = await resolveSymbolScope(uid, symbol);
  if (!scoped.ok) {
    res.status(400).json({ error: scoped.error });
    return;
  }
  const row = {
    id: randomUUID(),
    name,
    kind,
    symbol: scoped.symbol,
    userId: uid,
    paramsJson: JSON.stringify(params),
    sinksJson: JSON.stringify(sinks),
    throttleMs,
    enabled,
    createdAt: Date.now(),
  };
  await db.insert(alertRulesTable).values(row);
  // Force immediate engine reload so the new rule is evaluated on the
  // next tick/level update rather than waiting up to 10s for the
  // periodic refresh.
  refreshMuteCache();
  res.json({ rule: row });
});

router.put("/alerts/rules/:id", async (req, res) => {
  const uid = getUserId(req);
  const ruleId = cleanId(req.params.id);
  if (!ruleId) {
    res.status(400).json({ error: "Invalid rule id." });
    return;
  }
  const owned = await loadOwnedRule(uid, ruleId);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = req.body ?? {};
  const validation = validateRule(body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { name, kind, symbol, params, sinks, throttleMs, enabled } = validation.value;
  const scoped = await resolveSymbolScope(uid, symbol);
  if (!scoped.ok) {
    res.status(400).json({ error: scoped.error });
    return;
  }
  await db
    .update(alertRulesTable)
    .set({
      name,
      kind,
      symbol: scoped.symbol,
      paramsJson: JSON.stringify(params),
      sinksJson: JSON.stringify(sinks),
      throttleMs,
      enabled,
    })
    .where(eq(alertRulesTable.id, owned.id));
  refreshMuteCache();
  res.json({ ok: true });
});

router.delete("/alerts/rules/:id", async (req, res) => {
  const uid = getUserId(req);
  const ruleId = cleanId(req.params.id);
  if (!ruleId) {
    res.status(400).json({ error: "Invalid rule id." });
    return;
  }
  const owned = await loadOwnedRule(uid, ruleId);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await deleteRuleRuntime(owned.id);
  refreshMuteCache();
  res.json({ ok: true });
});

router.post("/alerts/rules/:id/test", async (req, res) => {
  const uid = getUserId(req);
  const ruleId = cleanId(req.params.id);
  if (!ruleId) {
    res.status(400).json({ error: "Invalid rule id." });
    return;
  }
  const owned = await loadOwnedRule(uid, ruleId);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await manualFire(owned.id);
  res.json(result);
});

router.get("/alerts/history", async (req, res) => {
  const uid = getUserId(req);
  const limit = boundedNumber(req.query.limit, 50, 1, MAX_HISTORY_LIMIT);
  // Scope history rows to rules owned by this user. We do this via an
  // explicit two-step join (collect this user's rule ids, then
  // inArray-filter history) so we never depend on a NOT NULL
  // constraint on alert_history.rule_id.
  const ruleRows = await db
    .select({ id: alertRulesTable.id })
    .from(alertRulesTable)
    .where(eq(alertRulesTable.userId, uid));
  const ruleIds = ruleRows.map((r) => r.id);
  if (ruleIds.length === 0) {
    res.json({ history: [] });
    return;
  }
  const rows = await db
    .select()
    .from(alertHistoryTable)
    .where(inArray(alertHistoryTable.ruleId, ruleIds))
    .orderBy(desc(alertHistoryTable.ts))
    .limit(limit);
  res.json({
    history: rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      symbol: r.symbol,
      kind: r.kind,
      message: r.message,
      payload: safeJson(r.payloadJson, {}),
      ts: r.ts,
      resolvedAt: r.resolvedAt,
    })),
  });
});

router.post("/alerts/history/:id/resolve", async (req, res) => {
  const uid = getUserId(req);
  const historyId = cleanId(req.params.id);
  if (!historyId) {
    res.status(400).json({ error: "Invalid history id." });
    return;
  }
  // Verify ownership through the linked rule before mutating.
  const histRow = await db
    .select({ id: alertHistoryTable.id, ruleId: alertHistoryTable.ruleId })
    .from(alertHistoryTable)
    .where(eq(alertHistoryTable.id, historyId))
    .limit(1);
  const hist = histRow[0];
  if (!hist) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (hist.ruleId) {
    const owned = await loadOwnedRule(uid, hist.ruleId);
    if (!owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  // History entries with no ruleId (engine-emitted system alerts) are
  // not resolvable by users — return 404 so we never let one user
  // resolve another's orphan history row.
  if (!hist.ruleId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db
    .update(alertHistoryTable)
    .set({ resolvedAt: Date.now() })
    .where(eq(alertHistoryTable.id, hist.id));
  res.json({ ok: true });
});

// ────────── mutes ──────────
router.get("/alerts/mutes", async (req, res) => {
  const uid = getUserId(req);
  const now = Date.now();
  const rows = await db
    .select()
    .from(alertMutesTable)
    .where(eq(alertMutesTable.userId, uid));
  res.json({
    mutes: rows
      .filter((r) => r.until > now)
      .map((r) => ({ id: r.id, symbol: r.symbol, ruleId: r.ruleId, until: r.until, createdAt: r.createdAt })),
  });
});

router.post("/alerts/mutes", async (req, res) => {
  const uid = getUserId(req);
  const body = req.body ?? {};
  const ruleIdIn = cleanId(body.ruleId) ?? "";
  const symbolIn = typeof body.symbol === "string" ? body.symbol.trim() : "";
  if (!ruleIdIn && !symbolIn) {
    res.status(400).json({ error: "symbol or ruleId required" }); return;
  }
  // If muting a specific rule, verify the rule belongs to this user.
  if (ruleIdIn) {
    const owned = await loadOwnedRule(uid, ruleIdIn);
    if (!owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  const symbol = ruleIdIn
    ? (symbolIn ? readAlertSymbol(symbolIn) : "*")
    : readAlertSymbol(symbolIn);
  if (!symbol) {
    res.status(400).json({ error: "Valid symbol required." });
    return;
  }
  const durationMs = boundedNumber(body.durationMs, 3600_000, MIN_MUTE_DURATION_MS, MAX_MUTE_DURATION_MS);
  const row = {
    id: randomUUID(),
    symbol,
    ruleId: ruleIdIn || null,
    userId: uid,
    until: Date.now() + durationMs,
    createdAt: Date.now(),
  };
  await db.insert(alertMutesTable).values(row);
  refreshMuteCache();
  res.json({ mute: row });
});

router.delete("/alerts/mutes/:id", async (req, res) => {
  const uid = getUserId(req);
  const muteId = cleanId(req.params.id);
  if (!muteId) {
    res.status(400).json({ error: "Invalid mute id." });
    return;
  }
  // Scope delete to mutes this user owns.
  await db
    .delete(alertMutesTable)
    .where(and(eq(alertMutesTable.id, muteId), eq(alertMutesTable.userId, uid)));
  refreshMuteCache();
  res.json({ ok: true });
});

router.get("/alerts/deliveries/:alertId", async (req, res) => {
  const uid = getUserId(req);
  const alertId = cleanId(req.params.alertId);
  if (!alertId) {
    res.status(400).json({ error: "Invalid alert id." });
    return;
  }
  // Verify the history row this delivery belongs to is owned by the
  // requesting user (via its rule).
  const histRow = await db
    .select({ ruleId: alertHistoryTable.ruleId })
    .from(alertHistoryTable)
    .where(eq(alertHistoryTable.id, alertId))
    .limit(1);
  const hist = histRow[0];
  if (!hist || !hist.ruleId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const owned = await loadOwnedRule(uid, hist.ruleId);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select()
    .from(alertDeliveriesTable)
    .where(eq(alertDeliveriesTable.alertId, alertId));
  res.json({ deliveries: rows });
});

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface ValidatedRule {
  name: string;
  kind: string;
  symbol: string;
  params: Record<string, unknown>;
  sinks: string[];
  throttleMs: number;
  enabled: boolean;
}

function validateRule(body: Record<string, unknown>): { ok: true; value: ValidatedRule } | { ok: false; error: string } {
  const name = readAlertName(body.name);
  if (!name) return { ok: false, error: "valid name required" };
  const kind = String(body.kind ?? "");
  if (!VALID_KINDS.has(kind)) return { ok: false, error: `invalid kind '${kind}'` };
  const symbol = readAlertSymbol(body.symbol);
  if (!symbol) return { ok: false, error: "valid symbol required" };
  if (symbol.startsWith("watchlist:") && symbol.slice("watchlist:".length).length === 0) {
    return { ok: false, error: "watchlist scope requires an id, e.g. 'watchlist:default'" };
  }
  const params = safeParams(body.params);
  if (!params) return { ok: false, error: "params must be a JSON object under 16KB" };
  const sinksRaw = Array.isArray(body.sinks) ? body.sinks : ["toast"];
  if (sinksRaw.length > MAX_SINKS) return { ok: false, error: "too many sinks" };
  const seenSinks = new Set<string>();
  const sinks = sinksRaw.filter((s): s is string => {
    if (typeof s !== "string" || !VALID_SINKS.has(s) || seenSinks.has(s)) return false;
    seenSinks.add(s);
    return true;
  });
  if (sinks.length === 0) return { ok: false, error: "at least one valid sink required" };

  if (sinks.includes("webhook") && !parseWebhookUrl(params.webhookUrl)) {
    return { ok: false, error: "webhook sink requires a public https:// params.webhookUrl" };
  }
  if (sinks.includes("discord") && !isDiscordWebhookUrl(params.discordUrl)) {
    return { ok: false, error: "discord URL must be a valid https://discord.com API webhook" };
  }

  const throttleMs = boundedNumber(body.throttleMs, 60_000, 1_000, 86_400_000);
  const enabled = body.enabled !== false;
  return { ok: true, value: { name, kind, symbol, params, sinks, throttleMs, enabled } };
}

export default router;
