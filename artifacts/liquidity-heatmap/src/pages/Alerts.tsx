import { useCallback, useEffect, useState } from "react";
import { Bell, Plus, Trash2, Zap, ToggleLeft, ToggleRight, Send, Check, BellOff, Copy } from "lucide-react";
import { apiUrl, readJson } from "@/lib/api";
import { ensureBrowserPushSubscription } from "@/lib/pushClient";

type AlertKind = "price_above" | "price_below" | "level_touch" | "tier_change" | "funding_flip";

interface AlertRule {
  id: string;
  name: string;
  kind: AlertKind;
  symbol: string;
  params: Record<string, unknown>;
  sinks: string[];
  throttleMs: number;
  enabled: boolean;
  createdAt: number;
}

interface AlertHistoryRow {
  id: string;
  ruleId: string | null;
  symbol: string;
  kind: string;
  message: string;
  payload: Record<string, unknown>;
  ts: number;
  resolvedAt: number | null;
}

interface MuteRow {
  id: string;
  symbol: string;
  ruleId: string | null;
  until: number;
  createdAt: number;
}

const KIND_LABEL: Record<AlertKind, string> = {
  price_above: "Price ≥",
  price_below: "Price ≤",
  level_touch: "Level touch",
  tier_change: "Tier upgrade",
  funding_flip: "Funding flip",
};

type SymbolScope = "single" | "all" | "watchlist";

function parseScope(symbol: string): { scope: SymbolScope; value: string } {
  if (symbol === "*") return { scope: "all", value: "*" };
  if (symbol.startsWith("watchlist:")) return { scope: "watchlist", value: symbol.slice("watchlist:".length) };
  return { scope: "single", value: symbol };
}

function scopeToSymbol(scope: SymbolScope, value: string): string {
  if (scope === "all") return "*";
  if (scope === "watchlist") return `watchlist:${value || "default"}`;
  return value.toUpperCase();
}

const SINK_LABEL: Record<string, string> = {
  toast: "Toast",
  webhook: "Webhook",
  discord: "Discord",
  push: "Push",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}


function safeCloneParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function alertError(res: Response, fallback: string): Promise<string> {
  const body = await readJson<{ error?: string }>(res, {});
  return body.error ?? fallback;
}
function emptyRule(): Partial<AlertRule> {
  return {
    name: "",
    kind: "price_above",
    symbol: "BTCUSDT",
    params: { price: 0 },
    sinks: ["toast"],
    throttleMs: 60000,
    enabled: true,
  };
}

export default function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [history, setHistory] = useState<AlertHistoryRow[]>([]);
  const [mutes, setMutes] = useState<MuteRow[]>([]);
  const [editing, setEditing] = useState<Partial<AlertRule> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, h, m] = await Promise.all([
        fetch(apiUrl(`/api/alerts/rules`), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl(`/api/alerts/history?limit=100`), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl(`/api/alerts/mutes`), { credentials: "include", cache: "no-store" }),
      ]);
      if (r.ok) {
        const body = await r.json();
        setRules(body.rules ?? []);
      }
      if (h.ok) {
        const body = await h.json();
        setHistory(body.history ?? []);
      }
      if (m.ok) {
        const body = await m.json();
        setMutes(body.mutes ?? []);
      }
    } catch (e) {
      console.warn("alerts load failed", e);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const save = async () => {
    if (!editing || !editing.name) return;
    const url = editingId
      ? apiUrl(`/api/alerts/rules/${encodeURIComponent(editingId)}`)
      : apiUrl(`/api/alerts/rules`);
    const method = editingId ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editing),
    });
    if (!res.ok) {
      const msg = await alertError(res, res.statusText);
      alert(`Save failed: ${msg}`);
      return;
    }
    setEditing(null);
    setEditingId(null);
    void load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this alert rule?")) return;
    await fetch(apiUrl(`/api/alerts/rules/${encodeURIComponent(id)}`), { method: "DELETE", credentials: "include" });
    void load();
  };

  const toggle = async (rule: AlertRule) => {
    await fetch(apiUrl(`/api/alerts/rules/${encodeURIComponent(rule.id)}`), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
    });
    void load();
  };

  const test = async (id: string) => {
    await fetch(apiUrl(`/api/alerts/rules/${encodeURIComponent(id)}/test`), { method: "POST", credentials: "include" });
    setTimeout(load, 500);
  };

  const resolve = async (id: string) => {
    await fetch(apiUrl(`/api/alerts/history/${encodeURIComponent(id)}/resolve`), {
      method: "POST", credentials: "include",
    });
    void load();
  };

  const muteSymbol = async (symbol: string) => {
    await fetch(apiUrl(`/api/alerts/mutes`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, durationMs: 3600_000 }),
    });
    void load();
  };

  const muteRule = async (rule: AlertRule) => {
    await fetch(apiUrl(`/api/alerts/mutes`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleId: rule.id, symbol: rule.symbol, durationMs: 3600_000 }),
    });
    void load();
  };

  const duplicate = async (rule: AlertRule) => {
    // Deep-copy params so the new rule keeps its own JSON blob. Name gets
    // a "(copy)" suffix and we reset enabled=true so it behaves like a
    // freshly-created rule. Throttle and sinks carry over 1:1.
    const payload: Partial<AlertRule> = {
      name: `${rule.name} (copy)`,
      kind: rule.kind,
      symbol: rule.symbol,
      params: safeCloneParams(rule.params),
      sinks: [...rule.sinks],
      throttleMs: rule.throttleMs,
      enabled: true,
    };
    const res = await fetch(apiUrl(`/api/alerts/rules`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const msg = await alertError(res, res.statusText);
      alert(`Duplicate failed: ${msg}`);
      return;
    }
    void load();
  };

  const unmute = async (id: string) => {
    await fetch(apiUrl(`/api/alerts/mutes/${encodeURIComponent(id)}`), {
      method: "DELETE", credentials: "include",
    });
    void load();
  };

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold flex items-center gap-2 text-cyan-200">
            <Bell className="w-4 h-4" /> ALERTS
          </h1>
          <button
            onClick={() => { setEditing(emptyRule()); setEditingId(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30"
            data-testid="alerts-create-rule"
          >
            <Plus className="w-3.5 h-3.5" /> New rule
          </button>
        </div>

        <section>
          <h2 className="text-xs uppercase tracking-wider text-white/40 mb-2">Rules</h2>
          {rules.length === 0 ? (
            <div className="text-xs text-white/40 border border-white/10 rounded p-6 text-center">
              No alert rules yet. Click <span className="text-cyan-300">New rule</span> to add one.
            </div>
          ) : (
            <div className="border border-white/10 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-white/5 text-white/50">
                  <tr>
                    <th className="text-left px-3 py-2">Name</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">Kind</th>
                    <th className="text-left px-3 py-2">Params</th>
                    <th className="text-left px-3 py-2">Sinks</th>
                    <th className="text-right px-3 py-2 w-32">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-t border-white/5 hover:bg-white/5">
                      <td className="px-3 py-2 text-white/90">{r.name}</td>
                      <td className="px-3 py-2 text-cyan-200">{r.symbol}</td>
                      <td className="px-3 py-2 text-white/70">{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td className="px-3 py-2 text-white/60 text-[10px]">{JSON.stringify(r.params)}</td>
                      <td className="px-3 py-2 text-white/60">{r.sinks.map((s) => SINK_LABEL[s] ?? s).join(", ")}</td>
                      <td className="px-3 py-2 text-right space-x-1">
                        <button onClick={() => toggle(r)} title={r.enabled ? "Disable" : "Enable"}>
                          {r.enabled ? <ToggleRight className="w-4 h-4 inline text-emerald-400" /> : <ToggleLeft className="w-4 h-4 inline text-white/40" />}
                        </button>
                        <button onClick={() => test(r.id)} title="Test fire">
                          <Send className="w-3.5 h-3.5 inline text-cyan-300" />
                        </button>
                        <button
                          onClick={() => duplicate(r)}
                          title="Duplicate rule"
                          data-testid={`duplicate-rule-${r.id}`}
                        >
                          <Copy className="w-3.5 h-3.5 inline text-white/60 hover:text-white" />
                        </button>
                        <button
                          onClick={() => muteRule(r)}
                          title="Mute this rule for 1 hour"
                          data-testid={`mute-rule-${r.id}`}
                        >
                          <BellOff className="w-3.5 h-3.5 inline text-amber-300 hover:text-amber-200" />
                        </button>
                        <button
                          onClick={() => { setEditing({ ...r }); setEditingId(r.id); }}
                          className="text-white/60 hover:text-white text-[10px] px-1"
                          title="Edit"
                        >EDIT</button>
                        <button onClick={() => remove(r.id)} title="Delete">
                          <Trash2 className="w-3.5 h-3.5 inline text-red-400" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wider text-white/40 mb-2 flex items-center gap-2">
            <Zap className="w-3.5 h-3.5" /> Recent fires
          </h2>
          {history.length === 0 ? (
            <div className="text-xs text-white/40 border border-white/10 rounded p-6 text-center">
              No alerts have fired yet.
            </div>
          ) : (
            <div className="border border-white/10 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-white/5 text-white/50">
                  <tr>
                    <th className="text-left px-3 py-2 w-40">When</th>
                    <th className="text-left px-3 py-2 w-40">Rule</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">Kind</th>
                    <th className="text-left px-3 py-2">Message</th>
                    <th className="text-right px-3 py-2 w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    // Resolve the rule name from the loaded rules list so
                    // users see a human-readable label in the feed, not
                    // just the opaque ruleId from the history row.
                    const ruleName = h.ruleId ? rules.find((r) => r.id === h.ruleId)?.name : null;
                    return (
                    <tr key={h.id} className={`border-t border-white/5 ${h.resolvedAt ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2 text-white/50">{formatTime(h.ts)}</td>
                      <td className="px-3 py-2 text-white/80 truncate" title={h.ruleId ?? ""}>
                        {ruleName ?? (h.ruleId ? <span className="text-white/40">{h.ruleId.slice(0, 8)}</span> : <span className="text-white/30">—</span>)}
                      </td>
                      <td className="px-3 py-2 text-cyan-200">{h.symbol}</td>
                      <td className="px-3 py-2 text-white/70">{h.kind}</td>
                      <td className="px-3 py-2 text-white/90">{h.message}</td>
                      <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
                        {!h.resolvedAt && (
                          <button
                            onClick={() => resolve(h.id)}
                            className="text-emerald-300 hover:text-emerald-200"
                            title="Mark resolved"
                            data-testid={`resolve-${h.id}`}
                          ><Check className="w-3.5 h-3.5 inline" /></button>
                        )}
                        {h.resolvedAt && (
                          <span className="text-[10px] text-emerald-400/70" title={`resolved ${formatTime(h.resolvedAt)}`}>✓ resolved</span>
                        )}
                        <button
                          onClick={() => muteSymbol(h.symbol)}
                          className="text-amber-300 hover:text-amber-200 ml-1"
                          title="Mute this symbol for 1 hour"
                        ><BellOff className="w-3.5 h-3.5 inline" /></button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {mutes.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-wider text-white/40 mb-2 flex items-center gap-2">
              <BellOff className="w-3.5 h-3.5" /> Active mutes
            </h2>
            <div className="border border-white/10 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-white/5 text-white/50">
                  <tr>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">Until</th>
                    <th className="text-right px-3 py-2 w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mutes.map((m) => {
                    // Look up the rule name for per-rule mutes so the user
                    // can tell which one is silenced at a glance.
                    const ruleName = m.ruleId ? rules.find((r) => r.id === m.ruleId)?.name : null;
                    const label = m.ruleId
                      ? <span className="text-amber-200">rule: {ruleName ?? m.ruleId.slice(0, 8)}</span>
                      : m.symbol;
                    return (
                      <tr key={m.id} className="border-t border-white/5">
                        <td className="px-3 py-2 text-cyan-200">{label}</td>
                        <td className="px-3 py-2 text-white/70">{formatTime(m.until)}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => unmute(m.id)}
                            className="text-white/60 hover:text-white text-[10px] px-1"
                            title="Cancel mute"
                          >UNMUTE</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          isNew={!editingId}
          onChange={setEditing}
          onCancel={() => { setEditing(null); setEditingId(null); }}
          onSave={save}
        />
      )}
    </div>
  );
}

interface EditorProps {
  rule: Partial<AlertRule>;
  isNew: boolean;
  onChange: (r: Partial<AlertRule>) => void;
  onCancel: () => void;
  onSave: () => void;
}

function RuleEditor({ rule, isNew, onChange, onCancel, onSave }: EditorProps) {
  const k = (rule.kind ?? "price_above") as AlertKind;
  const params = (rule.params ?? {}) as Record<string, number | string>;
  const sinks = rule.sinks ?? ["toast"];
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  // Populate the watchlist scope with real options from the server so
  // users don't have to remember watchlist ids. "default" is always
  // present (auto-seeded by the API), so a stale fetch still leaves a
  // sensible fallback.
  const [watchlistOptions, setWatchlistOptions] = useState<{ id: string; name: string }[]>([
    { id: "default", name: "Default" },
  ]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/watchlists`), { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { watchlists?: { id: string; name: string }[] };
        if (cancelled || !Array.isArray(body.watchlists) || body.watchlists.length === 0) return;
        setWatchlistOptions(body.watchlists.map((w) => ({ id: w.id, name: w.name || w.id })));
      } catch {
        // Keep fallback
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setParam = (key: string, value: number | string) => {
    onChange({ ...rule, params: { ...params, [key]: value } });
  };

  const toggleSink = (s: string) => {
    const enablingPush = s === "push" && !sinks.includes("push");
    const next = sinks.includes(s) ? sinks.filter((x) => x !== s) : [...sinks, s];
    onChange({ ...rule, sinks: next });
    if (enablingPush) {
      setPushStatus("Requesting browser permission…");
      void ensureBrowserPushSubscription()
        .then((result) => setPushStatus(result.message))
        .catch((err) => setPushStatus(err instanceof Error ? err.message : "Push setup failed."));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="bg-[#0c0c1d] border border-white/15 rounded-lg p-5 w-full max-w-md space-y-3 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-cyan-200">{isNew ? "New alert rule" : "Edit rule"}</div>

        <label className="block">
          <span className="text-white/50">Name</span>
          <input
            type="text"
            value={rule.name ?? ""}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
            data-testid="rule-editor-name"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <div className="block">
            <span className="text-white/50">Scope</span>
            <select
              value={parseScope(rule.symbol ?? "").scope}
              onChange={(e) => {
                const next = e.target.value as SymbolScope;
                const cur = parseScope(rule.symbol ?? "");
                onChange({ ...rule, symbol: scopeToSymbol(next, next === cur.scope ? cur.value : next === "watchlist" ? "default" : "BTCUSDT") });
              }}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
              data-testid="rule-editor-scope"
            >
              <option value="single">Single symbol</option>
              <option value="all">All symbols (*)</option>
              <option value="watchlist">Watchlist</option>
            </select>
            {(() => {
              const { scope, value } = parseScope(rule.symbol ?? "");
              if (scope === "single") {
                return (
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange({ ...rule, symbol: e.target.value.toUpperCase() })}
                    className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-cyan-200"
                    placeholder="BTCUSDT"
                  />
                );
              }
              if (scope === "watchlist") {
                // If the current value isn't in the loaded options (e.g.
                // it was typed manually earlier or a watchlist was
                // deleted), include it as a distinct option so the
                // select still reflects the rule's actual scope.
                const hasCurrent = watchlistOptions.some((w) => w.id === value);
                return (
                  <select
                    value={value || "default"}
                    onChange={(e) => onChange({ ...rule, symbol: scopeToSymbol("watchlist", e.target.value) })}
                    className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-cyan-200"
                    data-testid="rule-editor-watchlist"
                  >
                    {watchlistOptions.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                    {!hasCurrent && value && (
                      <option value={value}>{value} (missing)</option>
                    )}
                  </select>
                );
              }
              return (
                <div className="mt-1 text-[10px] text-white/40">Matches every symbol streamed by the engine.</div>
              );
            })()}
          </div>
          <label className="block">
            <span className="text-white/50">Kind</span>
            <select
              value={k}
              onChange={(e) => onChange({ ...rule, kind: e.target.value as AlertKind, params: {} })}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
            >
              <option value="price_above">Price above</option>
              <option value="price_below">Price below</option>
              <option value="level_touch">Level touch</option>
              <option value="tier_change">Tier upgrade</option>
              <option value="funding_flip">Funding flip</option>
            </select>
          </label>
        </div>

        {(k === "price_above" || k === "price_below") && (
          <label className="block">
            <span className="text-white/50">Trigger price</span>
            <input
              type="number"
              step="any"
              value={String(params.price ?? "")}
              onChange={(e) => setParam("price", parseFloat(e.target.value) || 0)}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
            />
          </label>
        )}

        {k === "level_touch" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-white/50">Min tier</span>
              <select
                value={String(params.minTier ?? 2)}
                onChange={(e) => setParam("minTier", parseInt(e.target.value, 10))}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
              >
                <option value="1">1 (normal)</option>
                <option value="2">2 (strong)</option>
                <option value="3">3 (elite)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-white/50">Tolerance %</span>
              <input
                type="number"
                step="0.01"
                value={String(params.tolerancePct ?? 0.15)}
                onChange={(e) => setParam("tolerancePct", parseFloat(e.target.value) || 0.15)}
                className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
              />
            </label>
          </div>
        )}

        <div>
          <span className="text-white/50">Sinks</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(["toast", "webhook", "discord", "push"] as const).map((s) => (
              <button
                key={s}
                onClick={() => toggleSink(s)}
                className={`px-2 py-1 rounded border text-[10px] ${
                  sinks.includes(s)
                    ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-200"
                    : "bg-white/5 border-white/10 text-white/50"
                }`}
              >{SINK_LABEL[s]}</button>
            ))}
          </div>
          {pushStatus && (
            <div className="mt-2 text-[10px] text-white/45 leading-relaxed" data-testid="push-status">
              {pushStatus}
            </div>
          )}
        </div>

        {sinks.includes("webhook") && (
          <label className="block">
            <span className="text-white/50">Webhook URL</span>
            <input
              type="url"
              value={String(params.webhookUrl ?? "")}
              onChange={(e) => setParam("webhookUrl", e.target.value)}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
              placeholder="https://..."
            />
          </label>
        )}
        {sinks.includes("discord") && (
          <label className="block">
            <span className="text-white/50">Discord webhook URL</span>
            <input
              type="url"
              value={String(params.discordUrl ?? "")}
              onChange={(e) => setParam("discordUrl", e.target.value)}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
              placeholder="https://discord.com/api/webhooks/..."
            />
          </label>
        )}

        <label className="block">
          <span className="text-white/50">Throttle (seconds)</span>
          <input
            type="number"
            min="1"
            value={Math.round((rule.throttleMs ?? 60000) / 1000)}
            onChange={(e) => onChange({ ...rule, throttleMs: Math.max(1000, (parseInt(e.target.value, 10) || 60) * 1000) })}
            className="mt-1 w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white"
          />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded bg-white/5 border border-white/10 text-white/70 hover:bg-white/10"
          >Cancel</button>
          <button
            onClick={onSave}
            className="px-3 py-1.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30"
            data-testid="rule-editor-save"
          >Save</button>
        </div>
      </div>
    </div>
  );
}
