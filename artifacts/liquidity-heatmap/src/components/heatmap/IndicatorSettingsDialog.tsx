import { useState, useEffect } from "react";
import { X } from "lucide-react";
import type { IndicatorInstance } from "@/lib/chartSettings";

interface Props {
  indicator: IndicatorInstance | null;
  onClose: () => void;
  onChange: (next: IndicatorInstance) => void;
  onRemove: (id: string) => void;
}

const PARAM_LABELS: Record<string, string> = {
  length: "Length",
  fast: "Fast Length",
  slow: "Slow Length",
  signal: "Signal Length",
  mult: "Std Dev",
  lookback: "Lookback",
  lev1: "Leverage 1 (×)",
  lev2: "Leverage 2 (×)",
  lev3: "Leverage 3 (×)",
  buffer: "Buffer (%)",
  windowMinutes: "Window (minutes)",
};

const PRETTY_TYPE: Record<string, string> = {
  sma: "Moving Average",
  ema: "Exponential Moving Average",
  rsi: "Relative Strength Index",
  bb: "Bollinger Bands",
  volume: "Volume",
  macd: "MACD",
  volume_delta: "Volume + Delta",
  cvd: "CVD",
  cvd_perp: "CVD PERP",
  fib_grid: "Fibonacci Grid",
  fib_retracement: "Fibonacci Retracement",
  liq_heatmap: "Liquidation Heatmap (What-if Projection)",
  liq_heatmap_light: "Liquidation Heatmap (What-if Projection Light)",
  liq_heatmap_real: "Liquidation Heatmap (Real)",
  candle_close_timer: "Candle Close Timer",
};

const COLOR_PRESETS = [
  "#22d3ee", "#60a5fa", "#a78bfa", "#e879f9", "#f472b6",
  "#f59e0b", "#facc15", "#84cc16", "#22c55e", "#10b981",
  "#ef4444", "#fb7185", "#94a3b8", "#ffffff",
];

export function IndicatorSettingsDialog({ indicator, onClose, onChange, onRemove }: Props) {
  const [draft, setDraft] = useState<IndicatorInstance | null>(indicator);

  useEffect(() => setDraft(indicator), [indicator]);

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft, onClose]);

  if (!indicator || !draft) return null;

  const apply = (next: IndicatorInstance) => {
    setDraft(next);
    onChange(next);
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[460px] max-w-[95vw] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: draft.color }}
            />
            <h2 className="text-sm font-semibold text-foreground truncate">
              {PRETTY_TYPE[draft.type] ?? draft.type.toUpperCase()} — Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4 max-h-[70vh] overflow-y-auto">
          {/* Parameters */}
          {Object.keys(draft.params).length > 0 && (
            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Inputs
              </div>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(draft.params).map(([k, v]) => (
                  <label key={k} className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      {PARAM_LABELS[k] ?? k}
                    </span>
                    <input
                      type="number"
                      value={v}
                      step={k === "buffer" || k === "mult" ? 0.1 : 1}
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (Number.isNaN(num)) return;
                        apply({ ...draft, params: { ...draft.params, [k]: num } });
                      }}
                      className="px-2 py-1.5 bg-accent border border-border rounded text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
                    />
                  </label>
                ))}
              </div>
            </section>
          )}

          {/* Style */}
          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
              Style
            </div>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={normalizeHex(draft.color)}
                onChange={(e) => apply({ ...draft, color: e.target.value })}
                className="w-10 h-8 rounded border border-border bg-transparent cursor-pointer"
              />
              <div className="flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => apply({ ...draft, color: c })}
                    className="w-5 h-5 rounded-sm border border-border hover:scale-110 transition-transform"
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </div>
          </section>

          {/* Pane (only meaningful for indicators that can switch) */}
          {canSwitchPane(draft.type) && (
            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Display
              </div>
              <div className="flex items-center gap-2">
                {(["overlay", "below"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => apply({ ...draft, pane: p })}
                    className={`px-3 py-1.5 text-xs rounded border ${
                      draft.pane === p
                        ? "bg-cyan-500/10 border-cyan-500/50 text-cyan-300"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p === "overlay" ? "On chart" : "Separate pane"}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Visibility */}
          <section>
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
              Visibility
            </div>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.visible !== false}
                onChange={(e) => apply({ ...draft, visible: e.target.checked })}
                className="accent-cyan-500"
              />
              Show on chart
            </label>
          </section>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-accent/20">
          <button
            onClick={() => {
              onRemove(draft.id);
              onClose();
            }}
            className="px-3 py-1.5 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10"
          >
            Remove indicator
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function canSwitchPane(t: IndicatorInstance["type"]): boolean {
  // Heatmaps/fibs/timer must stay overlay; rsi/macd/cvd must stay below.
  return ["sma", "ema", "bb", "volume", "volume_delta"].includes(t);
}

function normalizeHex(c: string): string {
  if (/^#([0-9a-f]{3}){1,2}$/i.test(c)) return c;
  // Try rgb()/rgba()
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    const [, r, g, b] = m;
    const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${toHex(r!)}${toHex(g!)}${toHex(b!)}`;
  }
  return "#22d3ee";
}
