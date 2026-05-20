import { useState, useEffect, useRef, MouseEvent } from "react";
import { Settings, Eye, EyeOff, Trash2, MoreHorizontal, ChevronDown } from "lucide-react";
import type { IndicatorInstance } from "@/lib/chartSettings";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  indicators: IndicatorInstance[];
  symbol: string;
  interval: string;
  onUpdate: (next: IndicatorInstance) => void;
  onRemove: (id: string) => void;
  onOpenSettings: (id: string) => void;
  /** y-offset to start from (e.g. push below OHLCV status line) */
  topOffset?: number;
}

const PRETTY_TYPE: Record<string, string> = {
  sma: "MA",
  ema: "EMA",
  rsi: "RSI",
  bb: "BB",
  volume: "Vol",
  macd: "MACD",
  volume_delta: "Vol+Δ",
  cvd: "CVD",
  cvd_perp: "CVD PERP",
  fib_grid: "Fib Grid",
  fib_retracement: "Fib Retracement",
  liq_heatmap: "Liq Heatmap (What-if)",
  liq_heatmap_light: "Liq Heatmap (What-if Light)",
  liq_heatmap_real: "Liq Heatmap (Real)",
  candle_close_timer: "Close Timer",
};

interface Menu {
  x: number;
  y: number;
  id: string;
}

export function IndicatorLegend({
  indicators,
  symbol,
  interval,
  onUpdate,
  onRemove,
  onOpenSettings,
  topOffset = 28,
}: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mobileExpanded) return;
    const onDoc = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (t && wrapRef.current && !wrapRef.current.contains(t)) {
        setMobileExpanded(false);
      }
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [mobileExpanded]);

  if (indicators.length === 0) return null;

  const openMenu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, id });
  };

  const target = menu ? indicators.find((i) => i.id === menu.id) : null;

  if (isMobile && !mobileExpanded) {
    return (
      <div
        ref={wrapRef}
        className="absolute left-3 z-20 select-none"
        style={{ top: topOffset }}
      >
        <button
          type="button"
          onClick={() => setMobileExpanded(true)}
          className="pointer-events-auto flex items-center gap-1 px-2 h-6 rounded bg-black/55 hover:bg-black/70 border border-white/10 text-[11px] font-mono text-white/90"
          data-testid="indicator-legend-mobile-chip"
          aria-label={`${indicators.length} indicators (tap to expand)`}
        >
          <span className="tabular-nums">{indicators.length}</span>
          <span className="text-white/60">ind</span>
          <ChevronDown className="w-3 h-3 opacity-70" />
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        ref={wrapRef}
        className={`absolute left-3 z-20 flex flex-col gap-0.5 select-none ${
          isMobile ? "max-h-[25%] overflow-y-auto pointer-events-auto bg-black/40 rounded p-1" : "pointer-events-none"
        }`}
        style={{ top: topOffset }}
      >
        {indicators.map((ind) => {
          const paramStr = Object.values(ind.params).join(" ");
          const visible = ind.visible !== false;
          return (
            <div
              key={ind.id}
              className="group flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-black/40 pointer-events-auto"
              onContextMenu={(e) => openMenu(e, ind.id)}
              onDoubleClick={() => onOpenSettings(ind.id)}
              data-testid={`indicator-legend-${ind.id}`}
              title="Double-click to edit · Right-click for menu"
            >
              <span
                className="w-2 h-2 rounded-sm shrink-0"
                style={{ backgroundColor: visible ? ind.color : "transparent", border: visible ? "none" : `1px solid ${ind.color}` }}
              />
              <span
                className={`text-[11px] font-mono whitespace-nowrap ${
                  visible ? "text-foreground" : "text-muted-foreground line-through"
                }`}
              >
                {PRETTY_TYPE[ind.type] ?? ind.type.toUpperCase()}
                {paramStr && (
                  <span className="text-muted-foreground ml-1">{paramStr}</span>
                )}
                <span className="text-[9px] text-muted-foreground/70 ml-1">
                  {symbol.toUpperCase()} · {interval}
                </span>
              </span>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-1">
                <button
                  onClick={() => onOpenSettings(ind.id)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdate({ ...ind, visible: !visible })}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  aria-label={visible ? "Hide" : "Show"}
                  title={visible ? "Hide" : "Show"}
                >
                  {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => onRemove(ind.id)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-red-400"
                  aria-label="Remove"
                  title="Remove"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => openMenu(e, ind.id)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  aria-label="More"
                  title="More"
                >
                  <MoreHorizontal className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {menu && target && (
        <>
          {/* Click-outside catcher */}
          <div
            className="fixed inset-0 z-[110]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div
            className="fixed z-[111] min-w-[180px] bg-card border border-border rounded-md shadow-2xl py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem
              label="Settings…"
              icon={<Settings className="w-3.5 h-3.5" />}
              onClick={() => { onOpenSettings(target.id); setMenu(null); }}
            />
            <MenuItem
              label={target.visible !== false ? "Hide" : "Show"}
              icon={target.visible !== false ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              onClick={() => {
                onUpdate({ ...target, visible: target.visible === false });
                setMenu(null);
              }}
            />
            <div className="my-1 border-t border-border" />
            {target.pane === "below" && (
              <MenuItem
                label="Move to chart"
                onClick={() => { onUpdate({ ...target, pane: "overlay" }); setMenu(null); }}
              />
            )}
            {target.pane === "overlay" && ["sma", "ema", "bb", "volume", "volume_delta"].includes(target.type) && (
              <MenuItem
                label="Move to separate pane"
                onClick={() => { onUpdate({ ...target, pane: "below" }); setMenu(null); }}
              />
            )}
            <div className="my-1 border-t border-border" />
            <MenuItem
              label="Remove"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              danger
              onClick={() => { onRemove(target.id); setMenu(null); }}
            />
          </div>
        </>
      )}
    </>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
  danger,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${
        danger ? "text-red-400 hover:text-red-300" : "text-foreground"
      }`}
    >
      {icon && <span className="opacity-70">{icon}</span>}
      <span className="text-xs">{label}</span>
    </button>
  );
}
