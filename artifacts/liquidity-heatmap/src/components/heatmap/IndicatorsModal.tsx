import { useState, useEffect, useMemo } from "react";
import { X, Search, Star, Plus, Check } from "lucide-react";
import type { IndicatorInstance } from "@/lib/chartSettings";

type Tab = "indicators" | "strategies" | "profiles" | "patterns";
type Section =
  | "favorites"
  | "scripts"
  | "invite"
  | "purchased"
  | "technicals"
  | "fundamentals"
  | "editors"
  | "top"
  | "trending";

interface CatalogItem {
  name: string;
  realType?: IndicatorInstance["type"];
  defaultParams?: Record<string, number>;
  defaultColor?: string;
  pane?: "overlay" | "below";
  group?: "personal" | "builtin";
}

const CATALOG: CatalogItem[] = [
  // Personal presets (THERMAL custom)
  { name: "Liquidation Heatmap (Real)", realType: "liq_heatmap_real", defaultParams: { windowMinutes: 15 }, defaultColor: "rgb(255,235,59)", pane: "overlay", group: "personal" },
  { name: "Liquidation Heatmap (What-if Projection)", realType: "liq_heatmap", defaultParams: { lev1: 5, lev2: 20, lev3: 100, buffer: 0.5 }, defaultColor: "rgb(255,235,59)", pane: "overlay", group: "personal" },
  { name: "Liquidation Heatmap Light (What-if Projection)", realType: "liq_heatmap_light", defaultParams: { lev1: 5, lev2: 20, lev3: 100, buffer: 0.5 }, defaultColor: "rgb(255,235,59)", pane: "overlay", group: "personal" },
  { name: "CandleClose 4hr/30min Timer", realType: "candle_close_timer", defaultParams: {}, defaultColor: "rgb(187,120,5)", pane: "overlay", group: "personal" },
  { name: "Fibonacci Grid", realType: "fib_grid", defaultParams: { lookback: 200 }, defaultColor: "rgb(255,235,59)", pane: "overlay", group: "personal" },
  { name: "Fibonacci Retracement", realType: "fib_retracement", defaultParams: { lookback: 200 }, defaultColor: "rgb(255,255,255)", pane: "overlay", group: "personal" },
  { name: "CVD", realType: "cvd", defaultParams: {}, defaultColor: "#3BCA6D", pane: "below", group: "personal" },
  { name: "CVD PERP", realType: "cvd_perp", defaultParams: {}, defaultColor: "#42a5f5", pane: "below", group: "personal" },
  { name: "Volume + Delta", realType: "volume_delta", defaultParams: {}, defaultColor: "rgb(59,202,109)", pane: "below", group: "personal" },
  { name: "Absorption & Reversal Levels", realType: "absorption_levels", defaultParams: { pivotLeft: 3, pivotRight: 3, seedLines: 12, mergeDistanceSteps: 3, groupStep: 5, showLabels: 1 }, defaultColor: "#10b981", pane: "overlay", group: "personal" },
  // Built-in technicals
  { name: "24-hour Volume" },
  { name: "Accumulation/Distribution" },
  { name: "Advance Decline Line" },
  { name: "Advance Decline Ratio" },
  { name: "Advance/Decline Ratio (Bars)" },
  { name: "Arnaud Legoux Moving Average" },
  { name: "Aroon" },
  { name: "Aroon Oscillator" },
  { name: "Auto Fib Extension" },
  { name: "Auto Fib Retracement" },
  { name: "Auto Pitchfork" },
  { name: "Average Directional Index" },
  { name: "Average True Range" },
  { name: "Awesome Oscillator" },
  { name: "Balance of Power" },
  { name: "Bollinger Bands", realType: "bb", defaultParams: { length: 20, mult: 2 }, defaultColor: "#60a5fa", pane: "overlay" },
  { name: "Bollinger Bands %B" },
  { name: "Bollinger Bands Width" },
  { name: "Chaikin Money Flow" },
  { name: "Chaikin Oscillator" },
  { name: "Chande Kroll Stop" },
  { name: "Chande Momentum Oscillator" },
  { name: "Choppiness Index" },
  { name: "Commodity Channel Index" },
  { name: "Connors RSI" },
  { name: "Coppock Curve" },
  { name: "Correlation Coefficient" },
  { name: "Detrended Price Oscillator" },
  { name: "Directional Movement Index" },
  { name: "Donchian Channels" },
  { name: "Double EMA" },
  { name: "Ease of Movement" },
  { name: "Elder Force Index" },
  { name: "EMA Cross" },
  { name: "Envelopes" },
  { name: "Exponential Moving Average", realType: "ema", defaultParams: { length: 20 }, defaultColor: "#f59e0b", pane: "overlay" },
  { name: "Fisher Transform" },
  { name: "Guppy Multiple Moving Average" },
  { name: "Historical Volatility" },
  { name: "Hull Moving Average" },
  { name: "Ichimoku Cloud" },
  { name: "Keltner Channels" },
  { name: "Klinger Oscillator" },
  { name: "Know Sure Thing" },
  { name: "Least Squares Moving Average" },
  { name: "Linear Regression Curve" },
  { name: "MA Cross" },
  { name: "MACD", realType: "macd", defaultParams: { fast: 12, slow: 26, signal: 9 }, defaultColor: "#a78bfa", pane: "below" },
  { name: "Mass Index" },
  { name: "McGinley Dynamic" },
  { name: "Median Price" },
  { name: "Momentum" },
  { name: "Money Flow Index" },
  { name: "Moving Average", realType: "sma", defaultParams: { length: 50 }, defaultColor: "#22d3ee", pane: "overlay" },
  { name: "Net Volume" },
  { name: "On Balance Volume" },
  { name: "Parabolic SAR" },
  { name: "Pivot Points High Low" },
  { name: "Pivot Points Standard" },
  { name: "Price Channel" },
  { name: "Price Oscillator" },
  { name: "Rate of Change" },
  { name: "Relative Strength Index", realType: "rsi", defaultParams: { length: 14 }, defaultColor: "#e879f9", pane: "below" },
  { name: "Relative Vigor Index" },
  { name: "Relative Volatility Index" },
  { name: "Schaff Trend Cycle" },
  { name: "SMI Ergodic Indicator" },
  { name: "Smoothed Moving Average" },
  { name: "Stochastic" },
  { name: "Stochastic RSI" },
  { name: "SuperTrend" },
  { name: "TRIX" },
  { name: "True Strength Index" },
  { name: "Ultimate Oscillator" },
  { name: "Volume", realType: "volume", defaultParams: {}, defaultColor: "#94a3b8", pane: "below" },
  { name: "Volume Oscillator" },
  { name: "Volume Weighted Average Price" },
  { name: "Vortex Indicator" },
  { name: "Williams %R" },
  { name: "Williams Alligator" },
  { name: "Williams Fractal" },
  { name: "Zig Zag" },
];

const SECTIONS_PERSONAL: { id: Section; label: string; icon: string }[] = [
  { id: "favorites", label: "Favorites", icon: "★" },
  { id: "scripts", label: "My scripts", icon: "👤" },
  { id: "invite", label: "Invite-only", icon: "👥" },
  { id: "purchased", label: "Purchased", icon: "🛒" },
];
const SECTIONS_BUILTIN: { id: Section; label: string; icon: string }[] = [
  { id: "technicals", label: "Technicals", icon: "📊" },
  { id: "fundamentals", label: "Fundamentals", icon: "📈" },
];
const SECTIONS_COMMUNITY: { id: Section; label: string; icon: string }[] = [
  { id: "editors", label: "Editor's picks", icon: "📚" },
  { id: "top", label: "Top", icon: "🏆" },
  { id: "trending", label: "Trending", icon: "🔥" },
];

const FAVS_KEY = "thermal.indicatorFavorites.v1";

function loadFavs(): string[] {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return p;
  } catch {}
  return [];
}

interface Props {
  open: boolean;
  onClose: () => void;
  active: IndicatorInstance[];
  onAdd: (item: IndicatorInstance) => void;
  onRemove: (id: string) => void;
}

export function IndicatorsModal({ open, onClose, active, onAdd, onRemove }: Props) {
  const [tab, setTab] = useState<Tab>("indicators");
  const [section, setSection] = useState<Section>("technicals");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavs());
  const [showPlanned, setShowPlanned] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(FAVS_KEY, JSON.stringify(favorites));
    } catch {}
  }, [favorites]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const list = useMemo(() => {
    let items = CATALOG;
    if (section === "favorites") items = items.filter((i) => favorites.includes(i.name));
    else if (section === "scripts") items = items.filter((i) => i.group === "personal");
    else if (section === "technicals") items = items.filter((i) => i.group !== "personal");
    else if (section === "fundamentals") items = items.filter((i) => /Volume|Distribution|Money Flow/.test(i.name) && i.group !== "personal");
    else if (section === "editors") items = items.filter((i) => i.group === "personal" || i.realType != null);
    else if (section === "top") items = items.filter((i) => i.realType != null);
    else if (section === "trending") items = items.filter((i) => i.group === "personal");
    else if (section === "invite" || section === "purchased") items = [];
    if (!showPlanned) items = items.filter((i) => i.realType != null);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((i) => i.name.toLowerCase().includes(q));
    }
    return items;
  }, [section, search, favorites, showPlanned]);

  const toggleFav = (name: string) => {
    setFavorites((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));
  };

  const addItem = (item: CatalogItem) => {
    if (!item.realType) return;
    const inst: IndicatorInstance = {
      id: `${item.realType}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: item.realType,
      params: item.defaultParams ?? {},
      color: item.defaultColor ?? "#22d3ee",
      pane: item.pane ?? "overlay",
    };
    onAdd(inst);
  };

  const isActive = (item: CatalogItem) => {
    if (!item.realType) return false;
    return active.some((a) => a.type === item.realType);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[900px] max-w-[95vw] h-[600px] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            Indicators, metrics, and strategies
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="w-full pl-10 pr-3 py-2 bg-accent border border-border rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-cyan-500/50"
              data-testid="indicators-search"
            />
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <aside className="w-52 border-r border-border overflow-y-auto py-2 shrink-0">
            <SectionGroup title="Personal" sections={SECTIONS_PERSONAL} active={section} onPick={setSection} />
            <SectionGroup title="Built-in" sections={SECTIONS_BUILTIN} active={section} onPick={setSection} />
            <SectionGroup title="Community" sections={SECTIONS_COMMUNITY} active={section} onPick={setSection} />
          </aside>
          <main className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-1 px-4 py-2 border-b border-border">
              {(["indicators", "strategies", "profiles", "patterns"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium capitalize ${
                    tab === t
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowPlanned((v) => !v)}
                className={`ml-auto px-2.5 py-1.5 text-[10px] rounded-md border ${
                  showPlanned
                    ? "border-amber-400/50 bg-amber-500/10 text-amber-200"
                    : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
                }`}
                title="Show catalog entries that are listed for roadmap coverage but are not wired to the chart renderer yet."
                data-testid="indicator-show-planned"
              >
                {showPlanned ? "Showing live + planned" : "Live only"}
              </button>
            </div>
            <div className="px-4 pt-3 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              <span>Script name</span>
              <span>{CATALOG.filter((i) => i.realType != null).length} live / {CATALOG.length} catalog</span>
            </div>
            <div className="flex-1 overflow-y-auto" data-testid="indicators-list">
              {tab !== "indicators" ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No items in {tab}.
                </div>
              ) : list.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nothing here yet.
                </div>
              ) : (
                list.map((item) => {
                  const activeFlag = isActive(item);
                  return (
                    <div
                      key={item.name}
                      className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-accent/50 group cursor-default"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-foreground truncate">{item.name}</span>
                        {item.realType ? (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-mono uppercase shrink-0">
                            live
                          </span>
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 font-mono uppercase shrink-0">
                            planned
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => toggleFav(item.name)}
                          className="p-1 rounded hover:bg-accent"
                          aria-label="Favorite"
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${
                              favorites.includes(item.name)
                                ? "fill-cyan-400 text-cyan-400"
                                : "text-muted-foreground"
                            }`}
                          />
                        </button>
                        {item.realType ? (
                          <button
                            onClick={() => {
                              if (activeFlag) {
                                const inst = active.find((a) => a.type === item.realType);
                                if (inst) onRemove(inst.id);
                              } else {
                                addItem(item);
                              }
                            }}
                            className={`p-1 rounded hover:bg-accent ${
                              activeFlag ? "text-emerald-400" : "text-muted-foreground hover:text-foreground"
                            }`}
                            aria-label={activeFlag ? "Remove" : "Add"}
                            data-testid={`indicator-toggle-${item.realType}`}
                          >
                            {activeFlag ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                          </button>
                        ) : (
                          <button
                            disabled
                            className="p-1 rounded text-white/20 cursor-not-allowed"
                            aria-label="Planned indicator not yet wired"
                            title="Planned catalog entry — hidden by default so no toolbar item behaves like a no-op."
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {active.length > 0 && (
              <div className="border-t border-border px-4 py-2 bg-accent/30">
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                  Active ({active.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {active.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-accent border border-border"
                      style={{ borderLeftColor: a.color, borderLeftWidth: 2 }}
                    >
                      {a.type.toUpperCase()}
                      {Object.keys(a.params).length > 0 && (
                        <span className="text-muted-foreground">
                          {Object.values(a.params).join(",")}
                        </span>
                      )}
                      <button
                        onClick={() => onRemove(a.id)}
                        className="hover:text-red-400"
                        aria-label="Remove"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function SectionGroup({
  title,
  sections,
  active,
  onPick,
}: {
  title: string;
  sections: { id: Section; label: string; icon: string }[];
  active: Section;
  onPick: (s: Section) => void;
}) {
  return (
    <div className="mb-2">
      <div className="px-4 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {sections.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(s.id)}
          className={`w-full flex items-center gap-2 px-4 py-1.5 text-sm ${
            active === s.id
              ? "bg-accent text-foreground border-l-2 border-cyan-400"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          }`}
        >
          <span className="text-base leading-none w-4 text-center">{s.icon}</span>
          <span>{s.label}</span>
        </button>
      ))}
    </div>
  );
}
