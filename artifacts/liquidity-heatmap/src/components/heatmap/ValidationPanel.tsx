// =====================================================================
// PERMANENT GUARDRAIL — DO NOT REMOVE OR LOOSEN
// =====================================================================
// This panel is a DISPLAY/CONTROL surface for the SEALED validation-only
// backend. It MUST NEVER:
//   • feed validation results back into the live engine, registry, or alerts
//   • be moved into the engine package
//   • read engine state directly (it goes through /api/liquidity/hl-validation)
// =====================================================================

import { useCallback, useEffect, useState } from "react";
import { Play, X, Download, RefreshCw, Loader2, FlaskConical } from "lucide-react";

type Profile = "quick" | "standard" | "full";
type Phase =
  | "queued" | "fetching-data" | "anti-lookahead" | "walk-forward"
  | "benchmarks" | "writing-report" | "done" | "cancelled" | "failed";

interface RunStatus {
  runId: string;
  profile: Profile;
  phase: Phase;
  progress: number;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  reportPath?: string;
  resultClass?: string;
  headline?: {
    expectancyR: number;
    sampleSize: number;
    foldCount: number;
    winRate: number;
    winRateLow95: number;
    winRateHigh95: number;
  };
  errors: string[];
}

const BASE = "/api/liquidity/hl-validation";
const PHASE_LABEL: Record<Phase, string> = {
  queued: "QUEUED",
  "fetching-data": "FETCHING HL DATA",
  "anti-lookahead": "ANTI-LOOKAHEAD",
  "walk-forward": "WALK-FORWARD",
  benchmarks: "BENCHMARKS",
  "writing-report": "WRITING REPORT",
  done: "DONE",
  cancelled: "CANCELLED",
  failed: "FAILED",
};

const RESULT_BADGE_CLASS: Record<string, string> = {
  "headline-eligible": "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  "moderate-confidence": "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  "low-confidence": "bg-amber-500/20 text-amber-300 border-amber-500/40",
  "very-low-sample": "bg-amber-500/20 text-amber-300 border-amber-500/40",
  "below-benchmark": "bg-rose-500/20 text-rose-300 border-rose-500/40",
  "anti-lookahead-failed": "bg-rose-500/30 text-rose-200 border-rose-500/60",
  "data-integrity-failed": "bg-rose-500/30 text-rose-200 border-rose-500/60",
};

interface ValidationPanelProps {
  onClose: () => void;
}

export function ValidationPanel({ onClose }: ValidationPanelProps) {
  const [profile, setProfile] = useState<Profile>("quick");
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/runs`, { credentials: "include" });
      if (!r.ok) throw new Error(`runs: HTTP ${r.status}`);
      const j = (await r.json()) as { runs: RunStatus[] };
      setRuns(j.runs ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BASE}/start`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!r.ok) throw new Error(`start: HTTP ${r.status}`);
      const s = (await r.json()) as RunStatus;
      setActiveRunId(s.runId);
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }, [profile, refresh]);

  const cancel = useCallback(async (runId: string) => {
    try {
      const r = await fetch(`${BASE}/cancel/${runId}`, { method: "POST", credentials: "include" });
      if (!r.ok && r.status !== 404) throw new Error(`cancel: HTTP ${r.status}`);
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh]);

  const downloadReport = useCallback((runId: string) => {
    const a = document.createElement("a");
    a.href = `${BASE}/report/${runId}`;
    a.download = `${runId}.md`;
    document.body.appendChild(a); a.click(); a.remove();
  }, []);

  return (
    <div className="flex flex-col bg-card text-card-foreground" data-testid="validation-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-xs">
          <FlaskConical className="w-4 h-4 text-cyan-400" />
          <span className="font-bold">HL VALIDATION</span>
          <span className="text-muted-foreground">/ Hyperliquid only / sealed</span>
        </div>
        <button onClick={onClose} aria-label="close" className="text-muted-foreground hover:text-foreground" data-testid="button-validation-close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">PROFILE</span>
        {(["quick","standard","full"] as Profile[]).map((p) => (
          <button key={p}
            onClick={() => setProfile(p)}
            className={`px-2 py-0.5 rounded border font-mono text-[11px] uppercase ${profile === p ? "border-primary text-primary bg-accent" : "border-border text-muted-foreground hover:text-foreground"}`}
            data-testid={`button-profile-${p}`}
          >{p}</button>
        ))}
        <div className="flex-1" />
        <button onClick={start} disabled={busy}
          className="flex items-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground font-mono text-[11px] uppercase disabled:opacity-50"
          data-testid="button-validation-start"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          START
        </button>
        <button onClick={refresh}
          className="flex items-center gap-1 px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground font-mono text-[11px]"
          data-testid="button-validation-refresh"
        ><RefreshCw className="w-3 h-3" /></button>
      </div>

      {err ? (
        <div className="px-3 py-2 text-[11px] font-mono text-rose-300 bg-rose-500/10 border-b border-rose-500/30">{err}</div>
      ) : null}

      <div className="overflow-auto max-h-[420px]">
        {runs.length === 0 ? (
          <div className="px-3 py-6 text-center font-mono text-[11px] text-muted-foreground">
            No runs yet. Pick a profile and click START.<br/>Reports are written to <code>reports/hl-validation/</code>.
          </div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left px-2 py-1">RUN</th>
                <th className="text-left px-2 py-1">PHASE</th>
                <th className="text-right px-2 py-1">PROG</th>
                <th className="text-right px-2 py-1">N</th>
                <th className="text-right px-2 py-1">FOLDS</th>
                <th className="text-right px-2 py-1">EXP R</th>
                <th className="text-right px-2 py-1">WIN%</th>
                <th className="text-left px-2 py-1">RESULT</th>
                <th className="text-right px-2 py-1">ACT</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className={`border-b border-border/50 hover:bg-accent/30 ${activeRunId === r.runId ? "bg-accent/20" : ""}`} data-testid={`row-run-${r.runId}`}>
                  <td className="px-2 py-1.5">
                    <div className="text-foreground">{r.runId}</div>
                    <div className="text-[10px] text-muted-foreground uppercase">{r.profile}</div>
                  </td>
                  <td className="px-2 py-1.5">{PHASE_LABEL[r.phase]}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{(r.progress * 100).toFixed(0)}%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.headline?.sampleSize ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.headline?.foldCount ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.headline ? (r.headline.expectancyR >= 0 ? "+" : "") + r.headline.expectancyR.toFixed(3) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.headline ? (r.headline.winRate * 100).toFixed(1) + "%" : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.resultClass ? (
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase ${RESULT_BADGE_CLASS[r.resultClass] ?? "border-border text-muted-foreground"}`}>
                        {r.resultClass}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {r.phase === "done" ? (
                      <button onClick={() => downloadReport(r.runId)} aria-label="download report"
                        className="text-cyan-400 hover:text-cyan-300" data-testid={`button-download-${r.runId}`}>
                        <Download className="w-3.5 h-3.5 inline" />
                      </button>
                    ) : r.phase === "queued" || r.phase === "fetching-data" || r.phase === "anti-lookahead" || r.phase === "walk-forward" || r.phase === "benchmarks" || r.phase === "writing-report" ? (
                      <button onClick={() => cancel(r.runId)} className="text-rose-400 hover:text-rose-300" data-testid={`button-cancel-${r.runId}`}>
                        <X className="w-3.5 h-3.5 inline" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-[10px] font-mono text-muted-foreground">
        Sealed engine · Hyperliquid only · validation-only · live registry untouched
      </div>
    </div>
  );
}
