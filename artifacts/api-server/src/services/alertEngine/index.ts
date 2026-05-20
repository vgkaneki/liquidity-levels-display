// Alert engine — T002.
//
// Reads alert_rules from the DB, evaluates them against the live ticker
// stream and the level registry, throttles, dispatches to sinks
// (toast/webhook/discord/push-stub), and persists everything to
// alert_history + alert_deliveries.
//
// Rule scoping:
//   - `rule.symbol = "BTCUSDT"` — single canonical symbol
//   - `rule.symbol = "*"`       — every symbol seen by the engine
//   - `rule.symbol = "watchlist:<id>"` — every symbol in that watchlist;
//     resolved at eval time via a small cached map refreshed on every
//     rule reload.
//
// Dispatch guarantees:
//   - Webhook + Discord sinks retry with exponential backoff (3 attempts,
//     250ms / 1s / 4s) and time out individually at 5s.
//   - Discord payload is a rich embed (title, color, fields).
//   - Outbound URLs go through an SSRF guard (https-only, public IPs,
//     redirect disabled).
//   - Per-symbol mutes in `alert_mutes` suppress dispatch until their
//     `until` timestamp passes.

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { db } from "@workspace/db";
import {
  alertDeliveriesTable,
  alertHistoryTable,
  alertMutesTable,
  alertRulesTable,
  watchlistSymbolsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { okxStore, hlStore, subscribeTickerUpdates } from "../../routes/liquidity/exchanges/ws-store";
import { levelRegistry, type RegistryLevel } from "../levelRegistry";
import { publishScannerAlert } from "../wsHub";
import { sendWebPushToUser } from "../push/webPush";

export interface AlertRule {
  id: string;
  // The owner of this rule. Used to scope toast delivery (so user A's
  // alert never lands in user B's WS) and to scope mute lookups (so
  // user A's mute never suppresses user B's alert). Rules with an
  // empty userId are pre-multi-user legacy rows and are dropped at
  // reload time — see `reloadRules` below.
  userId: string;
  name: string;
  kind: "price_above" | "price_below" | "level_touch" | "tier_change" | "funding_flip";
  symbol: string; // canonical, "*", or "watchlist:<id>"
  params: Record<string, unknown>;
  sinks: string[];
  throttleMs: number;
  enabled: boolean;
}

interface RuntimeState {
  lastFiredAt: number;
  lastTier?: number;
  lastPrice?: number;
  lastFundingSign?: 1 | -1 | 0;
}

const rules = new Map<string, AlertRule>();
// Keyed by `${ruleId}::${symbol}` so wildcard / watchlist rules maintain
// independent lastPrice / lastTier / lastFundingSign / lastFiredAt per
// concrete symbol.
const runtime = new Map<string, RuntimeState>();
// watchlistId -> Set of canonical symbols. Refreshed alongside rules.
const watchlistMembers = new Map<string, Set<string>>();
// Active mutes, scoped per user so that user A muting BTCUSDT never
// suppresses user B's BTCUSDT alerts. Inner map: symbol ("*" or
// canonical) -> until ts. Refreshed with rules.
const userSymbolMutes = new Map<string, Map<string, number>>();
// Per-rule mutes: ruleId -> until ts. Already implicitly per-user
// because each rule has a single owner enforced at the route layer.
const ruleMutes = new Map<string, number>();
let started = false;
const ALERT_RULE_RELOAD_MS = Math.max(30_000, Number(process.env.ALERT_RULE_RELOAD_MS ?? "45000") || 45_000);
const ALERT_LEVEL_EVAL_DEBOUNCE_MS = Math.max(250, Number(process.env.ALERT_LEVEL_EVAL_DEBOUNCE_MS ?? "750") || 750);
const ALERT_DISPATCH_CONCURRENCY = Math.max(1, Number(process.env.ALERT_DISPATCH_CONCURRENCY ?? "3") || 3);
let alertDispatchActive = 0;
const alertDispatchQueue: Array<() => Promise<void>> = [];
const pendingLevelEval = new Map<string, NodeJS.Timeout>();

function runAlertQueue(): void {
  while (alertDispatchActive < ALERT_DISPATCH_CONCURRENCY && alertDispatchQueue.length > 0) {
    const task = alertDispatchQueue.shift()!;
    alertDispatchActive += 1;
    void task().finally(() => {
      alertDispatchActive -= 1;
      runAlertQueue();
    });
  }
}

function enqueueAlertDispatch(task: () => Promise<void>): void {
  alertDispatchQueue.push(task);
  runAlertQueue();
}

function stateKey(ruleId: string, symbol: string): string {
  return `${ruleId}::${symbol}`;
}

// ─────────────────────────── SSRF guard ───────────────────────────
const PRIVATE_CIDR_PATTERNS: RegExp[] = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64/10
  /^22[4-9]\./, /^23[0-9]\./, // multicast 224-239
  /^24[0-9]\./, /^25[0-5]\./, // reserved 240+
];

function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_CIDR_PATTERNS.some((rx) => rx.test(ip));
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice(7));
  return false;
}

async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("invalid URL"); }
  if (parsed.protocol !== "https:") throw new Error("only https:// is allowed");
  const host = parsed.hostname;
  const addrs = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dnsLookup(host, { all: true });
  for (const a of addrs) {
    const isV6 = a.family === 6;
    const blocked = isV6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address);
    if (blocked) throw new Error(`refusing to connect to private/reserved address ${a.address}`);
  }
  return parsed;
}

async function safeFetchOnce(url: string, init: RequestInit): Promise<Response> {
  const safe = await assertSafeOutboundUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await fetch(safe.toString(), { ...init, signal: ctrl.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}

// Retry with exponential backoff. Retries on network error or 5xx/429.
async function safeFetchRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [0, 250, 1000, 4000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const res = await safeFetchOnce(url, init);
      if (res.ok) return res;
      // Retry on transient HTTP classes only.
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`upstream ${res.status}`);
        continue;
      }
      return res; // non-retriable client error; return as-is
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("retry exhausted");
}

// ─────────────────────────── rule + mute reload ───────────────────────────
function rowToRule(r: typeof alertRulesTable.$inferSelect): AlertRule {
  let params: Record<string, unknown> = {};
  let sinks: string[] = ["toast"];
  try { params = JSON.parse(r.paramsJson); } catch { /* default */ }
  try {
    const parsed = JSON.parse(r.sinksJson);
    if (Array.isArray(parsed)) sinks = parsed.filter((s) => typeof s === "string");
  } catch { /* default */ }
  return {
    id: r.id,
    userId: r.userId ?? "",
    name: r.name,
    kind: r.kind as AlertRule["kind"],
    symbol: r.symbol,
    params,
    sinks,
    throttleMs: r.throttleMs,
    enabled: r.enabled,
  };
}

async function reloadRules(): Promise<void> {
  try {
    const rows = await db.select().from(alertRulesTable);
    rules.clear();
    for (const r of rows) {
      // Drop legacy NULL-userId rules entirely. They have no owner to
      // deliver toasts to and we don't want them silently consuming
      // engine cycles or polluting the mute cache.
      if (!r.userId) continue;
      rules.set(r.id, rowToRule(r));
    }
  } catch (e) {
    logger.warn({ err: e }, "alert-engine: rule reload failed");
  }

  // Refresh watchlist membership cache (small N, run every 10s).
  try {
    const ws = await db.select().from(watchlistSymbolsTable);
    watchlistMembers.clear();
    for (const row of ws) {
      const set = watchlistMembers.get(row.watchlistId) ?? new Set<string>();
      set.add(row.symbol);
      watchlistMembers.set(row.watchlistId, set);
    }
  } catch (e) {
    logger.warn({ err: e }, "alert-engine: watchlist reload failed");
  }

  // Refresh mute cache, drop expired. Symbol mutes are bucketed by
  // userId so a mute set by user A cannot silence user B's alerts.
  try {
    const now = Date.now();
    const rows = await db.select().from(alertMutesTable);
    userSymbolMutes.clear();
    ruleMutes.clear();
    for (const m of rows) {
      if (m.until <= now) continue;
      if (!m.userId) continue; // skip legacy NULL-userId mute rows
      if (m.ruleId) {
        ruleMutes.set(m.ruleId, Math.max(ruleMutes.get(m.ruleId) ?? 0, m.until));
      } else {
        let bucket = userSymbolMutes.get(m.userId);
        if (!bucket) {
          bucket = new Map();
          userSymbolMutes.set(m.userId, bucket);
        }
        bucket.set(m.symbol, Math.max(bucket.get(m.symbol) ?? 0, m.until));
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "alert-engine: mutes reload failed");
  }
}

// True if the rule's scope includes this canonical symbol.
function ruleMatchesSymbol(rule: AlertRule, symbol: string): boolean {
  if (rule.symbol === symbol) return true;
  if (rule.symbol === "*") return true;
  if (rule.symbol.startsWith("watchlist:")) {
    const id = rule.symbol.slice("watchlist:".length);
    return watchlistMembers.get(id)?.has(symbol) ?? false;
  }
  return false;
}

function isSymbolMuted(userId: string, symbol: string): boolean {
  const bucket = userSymbolMutes.get(userId);
  if (!bucket) return false;
  const now = Date.now();
  const wildcard = bucket.get("*") ?? 0;
  const specific = bucket.get(symbol) ?? 0;
  return wildcard > now || specific > now;
}

function isRuleMuted(ruleId: string): boolean {
  const until = ruleMutes.get(ruleId) ?? 0;
  return until > Date.now();
}

// ─────────────────────────── price / funding helpers ───────────────────────────
function priceFor(symbol: string): number | null {
  const okx = okxStore.getTicker(symbol);
  if (okx) {
    const p = parseFloat(okx.last);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const base = symbol.replace(/USDT$/, "");
  const hl = hlStore.getAsset(base);
  if (hl && hl.markPx > 0) return hl.markPx;
  return null;
}

function fundingRateFor(symbol: string): number | null {
  const base = symbol.replace(/USDT$/, "");
  const hl = hlStore.getAsset(base);
  if (hl && typeof hl.funding === "number" && Number.isFinite(hl.funding)) return hl.funding;
  const okx = okxStore.getTicker(symbol);
  if (okx && typeof (okx as Record<string, unknown>).fundingRate === "string") {
    const n = parseFloat((okx as Record<string, string>).fundingRate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ─────────────────────────── dispatch ───────────────────────────
async function dispatchNow(rule: AlertRule, message: string, payload: Record<string, unknown>, price: number, firedSymbol?: string): Promise<void> {
  const alertId = randomUUID();
  const now = Date.now();
  const symbol = firedSymbol ?? rule.symbol;

  if (isRuleMuted(rule.id)) {
    logger.info({ ruleId: rule.id, symbol }, "alert-engine: suppressed by rule-mute");
    return;
  }
  if (isSymbolMuted(rule.userId, symbol)) {
    logger.info({ ruleId: rule.id, symbol }, "alert-engine: suppressed by mute");
    return;
  }

  try {
    await db.insert(alertHistoryTable).values({
      id: alertId,
      ruleId: rule.id,
      symbol,
      kind: rule.kind,
      message,
      payloadJson: JSON.stringify(payload),
      ts: now,
    });
  } catch (e) {
    logger.warn({ err: e }, "alert-engine: history insert failed");
  }

  for (const sink of rule.sinks) {
    let status: "ok" | "error" = "ok";
    let errorMsg: string | null = null;
    try {
      if (sink === "toast") {
        // Toast is the in-browser delivery sink. We tag the alert with
        // the rule owner's userId so the WS hub only fans it out to
        // that user's connected sockets — never to other logged-in
        // users sharing the same `scanner:alerts` channel.
        publishScannerAlert({
          id: alertId,
          userId: rule.userId,
          symbol,
          kind: rule.kind,
          message: `[${rule.name}] ${message}`,
          ts: now,
        });
      } else if (sink === "webhook") {
        const url = (rule.params.webhookUrl as string) ?? "";
        if (!url) throw new Error("webhook url missing in rule.params");
        const res = await safeFetchRetry(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ruleId: rule.id, ruleName: rule.name, alertId,
            symbol, kind: rule.kind, message, price, ts: now, payload,
          }),
        });
        if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      } else if (sink === "discord") {
        const url = (rule.params.discordUrl as string) ?? "";
        if (!url) throw new Error("discord url missing in rule.params");
        const chartUrl = (rule.params.chartUrl as string) ?? "";
        const color = rule.kind === "price_below" ? 0xef4444
          : rule.kind === "price_above" ? 0x22c55e
          : rule.kind === "funding_flip" ? 0xf59e0b
          : 0x06b6d4;
        const fields: { name: string; value: string; inline?: boolean }[] = [
          { name: "Symbol", value: `\`${symbol}\``, inline: true },
          { name: "Price", value: price.toFixed(price >= 100 ? 2 : 6), inline: true },
          { name: "Kind", value: rule.kind, inline: true },
        ];
        if (payload.levelPrice !== undefined) {
          const lvl = Number(payload.levelPrice);
          fields.push({ name: "Level", value: String(payload.levelPrice), inline: true });
          // Distance from current price to the level, both absolute and
          // as a percentage — gives the trader an immediate sense of
          // proximity without needing to open the chart.
          if (Number.isFinite(lvl) && lvl > 0 && Number.isFinite(price)) {
            const absDist = Math.abs(price - lvl);
            const pctDist = (absDist / lvl) * 100;
            fields.push({
              name: "Distance",
              value: `${absDist.toFixed(absDist >= 100 ? 2 : 6)} (${pctDist.toFixed(2)}%)`,
              inline: true,
            });
          }
        }
        if (payload.tier !== undefined) fields.push({ name: "Tier", value: String(payload.tier), inline: true });
        // Deterministic chart URL derived from PUBLIC_APP_URL (falls
        // back to the explicit rule.params.chartUrl if the operator
        // provided one, preserving backwards compatibility).
        const appBase = (process.env.PUBLIC_APP_URL ?? "").replace(/\/$/, "");
        const resolvedChartUrl = chartUrl || (appBase ? `${appBase}/?symbol=${encodeURIComponent(symbol)}` : "");
        const embed: Record<string, unknown> = {
          title: rule.name,
          description: message,
          color,
          timestamp: new Date(now).toISOString(),
          fields,
          footer: { text: "Market Strategy · alerts" },
        };
        if (resolvedChartUrl) (embed as Record<string, unknown>).url = resolvedChartUrl;
        const res = await safeFetchRetry(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
        if (!res.ok) throw new Error(`discord returned ${res.status}`);
      } else if (sink === "push") {
        const result = await sendWebPushToUser(rule.userId, {
          title: `${symbol} ${rule.kind}`,
          body: `[${rule.name}] ${message}`,
          tag: `alert:${rule.id}:${symbol}`,
          url: `/alerts`,
          data: { alertId, ruleId: rule.id, symbol, kind: rule.kind, price, payload },
        });
        if (result.disabled) throw new Error("web push is not configured; set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");
        if (result.ok === 0) throw new Error("no active browser push subscriptions for this user");
      } else {
        throw new Error(`unknown sink: ${sink}`);
      }
    } catch (e) {
      status = "error";
      errorMsg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: e, sink, ruleId: rule.id }, "alert-engine: sink dispatch failed");
    }
    try {
      await db.insert(alertDeliveriesTable).values({
        id: randomUUID(),
        alertId,
        sink,
        status,
        error: errorMsg,
        ts: Date.now(),
      });
    } catch (e) {
      logger.warn({ err: e }, "alert-engine: delivery insert failed");
    }
  }
}

async function dispatch(rule: AlertRule, message: string, payload: Record<string, unknown>, price: number, firedSymbol?: string): Promise<void> {
  enqueueAlertDispatch(() => dispatchNow(rule, message, payload, price, firedSymbol));
}

// ─────────────────────────── evaluation ───────────────────────────
function evaluateOnPrice(symbol: string, price: number): void {
  for (const rule of rules.values()) {
    if (!rule.enabled) continue;
    if (!ruleMatchesSymbol(rule, symbol)) continue;
    if (rule.kind !== "price_above" && rule.kind !== "price_below" && rule.kind !== "funding_flip") continue;

    const key = stateKey(rule.id, symbol);
    const state = runtime.get(key) ?? { lastFiredAt: 0 };
    const now = Date.now();

    // Always refresh lastPrice even under throttle so we don't spam once
    // throttle releases.
    if (now - state.lastFiredAt < rule.throttleMs) {
      state.lastPrice = price;
      runtime.set(key, state);
      continue;
    }

    let fire = false;
    let message = "";
    const payload: Record<string, unknown> = { price, symbol };

    if (rule.kind === "price_above") {
      const target = Number(rule.params.price);
      if (Number.isFinite(target) && price >= target && (state.lastPrice === undefined || state.lastPrice < target)) {
        fire = true;
        message = `${symbol} crossed above ${target} (now ${price.toFixed(4)})`;
      }
    } else if (rule.kind === "price_below") {
      const target = Number(rule.params.price);
      if (Number.isFinite(target) && price <= target && (state.lastPrice === undefined || state.lastPrice > target)) {
        fire = true;
        message = `${symbol} crossed below ${target} (now ${price.toFixed(4)})`;
      }
    } else if (rule.kind === "funding_flip") {
      const funding = fundingRateFor(symbol);
      if (funding !== null) {
        const sign: 1 | -1 | 0 = funding > 0 ? 1 : funding < 0 ? -1 : 0;
        if (state.lastFundingSign !== undefined && state.lastFundingSign !== 0 && sign !== 0 && sign !== state.lastFundingSign) {
          fire = true;
          const fromLabel = state.lastFundingSign === 1 ? "positive" : "negative";
          const toLabel = sign === 1 ? "positive" : "negative";
          message = `${symbol} funding flipped ${fromLabel} → ${toLabel} (${(funding * 100).toFixed(4)}%)`;
          payload.funding = funding;
          payload.prevSign = state.lastFundingSign;
        }
        state.lastFundingSign = sign;
      }
    }

    state.lastPrice = price;
    // Mute suppression must happen *before* we commit lastFiredAt, or the
    // throttle window would burn down while the symbol is muted and we'd
    // miss the next real event right after the mute expires. We still
    // update bookkeeping (lastPrice / lastFundingSign above) so we don't
    // stack-fire on unmute for the same edge.
    if (fire && !isSymbolMuted(rule.userId, symbol) && !isRuleMuted(rule.id)) {
      state.lastFiredAt = now;
      runtime.set(key, state);
      void dispatch(rule, message, payload, price, symbol);
    } else {
      runtime.set(key, state);
    }
  }
}

function evaluateOnLevels(symbol: string, levels: RegistryLevel[]): void {
  for (const rule of rules.values()) {
    if (!rule.enabled) continue;
    if (!ruleMatchesSymbol(rule, symbol)) continue;
    if (rule.kind !== "level_touch" && rule.kind !== "tier_change") continue;

    const key = stateKey(rule.id, symbol);
    const state = runtime.get(key) ?? { lastFiredAt: 0 };
    const now = Date.now();

    const minTier = Number(rule.params.minTier ?? 2);
    const tolerancePct = Number(rule.params.tolerancePct ?? 0.15) / 100;
    const price = priceFor(symbol);
    if (price === null) continue;

    if (rule.kind === "level_touch") {
      if (now - state.lastFiredAt < rule.throttleMs) continue;
      const hit = levels.find((l) => l.tier >= minTier && Math.abs(l.price - price) / price <= tolerancePct);
      // Mute check before committing lastFiredAt so a muted window can't
      // burn the throttle — see comment in evaluateOnPrice.
      if (hit && !isSymbolMuted(rule.userId, symbol) && !isRuleMuted(rule.id)) {
        state.lastFiredAt = now;
        runtime.set(key, state);
        void dispatch(rule, `${symbol} touched ${hit.side} @ ${hit.price.toFixed(4)} (tier ${hit.tier})`,
          { levelId: hit.id, levelPrice: hit.price, tier: hit.tier, side: hit.side, price, symbol }, price, symbol);
      }
    } else if (rule.kind === "tier_change") {
      const maxTier = levels.reduce((m, l) => Math.max(m, l.tier), 0);
      if (state.lastTier !== undefined && maxTier > state.lastTier) {
        if (now - state.lastFiredAt >= rule.throttleMs && !isSymbolMuted(rule.userId, symbol) && !isRuleMuted(rule.id)) {
          state.lastFiredAt = now;
          void dispatch(rule, `${symbol} top tier rose from ${state.lastTier} to ${maxTier}`,
            { from: state.lastTier, to: maxTier, symbol }, price, symbol);
        }
      }
      state.lastTier = maxTier;
      runtime.set(key, state);
    }
  }
}

// ─────────────────────────── bootstrap ───────────────────────────
export function startAlertEngine(): void {
  if (started) return;
  started = true;
  void reloadRules();
  setInterval(() => void reloadRules(), 10_000);

  subscribeTickerUpdates((exchange, symbol) => {
    const canonical = exchange === "hyperliquid" && !symbol.endsWith("USDT")
      ? `${symbol}USDT`
      : symbol;
    const price = priceFor(canonical);
    if (price === null) return;
    evaluateOnPrice(canonical, price);
  });

  levelRegistry.onUpdate((symbol, levels) => {
    const existing = pendingLevelEval.get(symbol);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingLevelEval.delete(symbol);
      evaluateOnLevels(symbol, levels);
    }, ALERT_LEVEL_EVAL_DEBOUNCE_MS);
    pendingLevelEval.set(symbol, timer);
  });

  logger.info("alert-engine: started");
}

// Public API for routes.
export async function manualFire(ruleId: string): Promise<{ ok: boolean; error?: string }> {
  const rule = rules.get(ruleId);
  if (!rule) {
    await reloadRules();
    const r2 = rules.get(ruleId);
    if (!r2) return { ok: false, error: "rule not found" };
    const fireSym = r2.symbol.startsWith("watchlist:") || r2.symbol === "*" ? "BTCUSDT" : r2.symbol;
    await dispatch(r2, "Test alert (manually fired)", { test: true }, priceFor(fireSym) ?? 0, fireSym);
    return { ok: true };
  }
  const fireSym = rule.symbol.startsWith("watchlist:") || rule.symbol === "*" ? "BTCUSDT" : rule.symbol;
  await dispatch(rule, "Test alert (manually fired)", { test: true }, priceFor(fireSym) ?? 0, fireSym);
  return { ok: true };
}

export async function deleteRuleRuntime(ruleId: string): Promise<void> {
  rules.delete(ruleId);
  const prefix = `${ruleId}::`;
  for (const k of runtime.keys()) {
    if (k.startsWith(prefix)) runtime.delete(k);
  }
  try {
    await db.delete(alertRulesTable).where(eq(alertRulesTable.id, ruleId));
  } catch (e) {
    logger.warn({ err: e }, "alert-engine: delete failed");
  }
}

export function refreshMuteCache(): void {
  void reloadRules();
}
