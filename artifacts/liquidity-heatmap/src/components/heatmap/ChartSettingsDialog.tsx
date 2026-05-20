import { useEffect, useState } from "react";
import { useChartSettings, useLiquidityLevels, ChartSettings, DEFAULT_SETTINGS } from "@/lib/chartSettings";
import { LEVEL_PRESETS, type LevelPresetId } from "@/lib/levelPresets";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Activity,
  AlignLeft,
  Ruler,
  Pencil,
  TrendingUp,
  Bell,
  Calendar,
  Layers,
  X,
} from "lucide-react";

type SectionKey = "symbol" | "statusLine" | "scalesAndLines" | "canvas" | "trading" | "events" | "alerts" | "liquidity";

const SECTIONS: { key: SectionKey; label: string; icon: typeof Activity }[] = [
  { key: "symbol", label: "Symbol", icon: Activity },
  { key: "liquidity", label: "Liquidity levels", icon: Layers },
  { key: "statusLine", label: "Status line", icon: AlignLeft },
  { key: "scalesAndLines", label: "Scales and lines", icon: Ruler },
  { key: "canvas", label: "Canvas", icon: Pencil },
  { key: "trading", label: "Trading", icon: TrendingUp },
  { key: "alerts", label: "Alerts", icon: Bell },
  { key: "events", label: "Events", icon: Calendar },
];

const TIMEZONES = [
  "(UTC) London",
  "(UTC-5) Chicago",
  "(UTC-5) New York",
  "(UTC-8) Los Angeles",
  "(UTC+1) Berlin",
  "(UTC+8) Hong Kong",
  "(UTC+9) Tokyo",
  "(UTC+10) Sydney",
];

function parseColor(v: string): { hex: string; alpha: number } {
  if (v.startsWith("#")) {
    const hex = v.length === 7 ? v : "#26a69a";
    return { hex, alpha: 1 };
  }
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (!m) return { hex: "#26a69a", alpha: 1 };
  const r = parseInt(m[1]!, 10), g = parseInt(m[2]!, 10), b = parseInt(m[3]!, 10);
  const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
  const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return { hex, alpha };
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (alpha >= 1) return hex;
  return `rgba(${r},${g},${b},${alpha})`;
}

function ColorSwatch({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const { hex, alpha } = parseColor(value);
  return (
    <label
      className={`relative inline-block w-7 h-6 rounded border border-white/20 cursor-pointer overflow-hidden ${className}`}
      style={{ backgroundColor: value }}
    >
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(hexToRgba(e.target.value, alpha))}
        className="absolute inset-0 opacity-0 cursor-pointer"
      />
    </label>
  );
}

function Row({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="flex flex-col gap-1 py-1.5 sm:grid sm:grid-cols-[160px_1fr] sm:items-center sm:gap-3">
      {label !== undefined ? (
        <div className="text-[13px] text-white/85">{label}</div>
      ) : (
        <div className="hidden sm:block" />
      )}
      <div className="flex items-center gap-2 min-w-0 flex-wrap">{children}</div>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        className="data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500 border-white/30"
      />
      <span className="text-[13px] text-white/85 flex-1">{label}</span>
      {children}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-[0.18em] text-white/40 uppercase mt-4 mb-2 font-mono">
      {children}
    </div>
  );
}

function SymbolPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.symbol;
  return (
    <div>
      <SectionHeader>Hollow candles</SectionHeader>
      <CheckRow label="Body" checked={s.hollowBody} onChange={(v) => update("symbol", { hollowBody: v })}>
        <ColorSwatch value={s.upColor} onChange={(c) => update("symbol", { upColor: c })} />
        <ColorSwatch value={s.downColor} onChange={(c) => update("symbol", { downColor: c })} />
      </CheckRow>
      <CheckRow label="Borders" checked={s.hollowBorders} onChange={(v) => update("symbol", { hollowBorders: v })}>
        <ColorSwatch value={s.borderUpColor} onChange={(c) => update("symbol", { borderUpColor: c })} />
        <ColorSwatch value={s.borderDownColor} onChange={(c) => update("symbol", { borderDownColor: c })} />
      </CheckRow>
      <CheckRow label="Wick" checked={s.hollowWick} onChange={(v) => update("symbol", { hollowWick: v })}>
        <ColorSwatch value={s.wickUpColor} onChange={(c) => update("symbol", { wickUpColor: c })} />
        <ColorSwatch value={s.wickDownColor} onChange={(c) => update("symbol", { wickDownColor: c })} />
      </CheckRow>

      <SectionHeader>Data modification</SectionHeader>
      <Row label="Precision">
        <Select value={s.precision} onValueChange={(v) => update("symbol", { precision: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["default", "1", "2", "3", "4", "5", "6", "7", "8"].map((p) => (
              <SelectItem key={p} value={p}>
                {p === "default" ? "Default" : `${p} digits`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Timezone">
        <Select value={s.timezone} onValueChange={(v) => update("symbol", { timezone: v })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </div>
  );
}

function StatusLinePanel() {
  const { settings, update } = useChartSettings();
  const s = settings.statusLine;
  return (
    <div>
      <SectionHeader>Instrument</SectionHeader>
      <CheckRow label="Logo" checked={s.logo} onChange={(v) => update("statusLine", { logo: v })} />
      <CheckRow label="Title" checked={s.title} onChange={(v) => update("statusLine", { title: v })}>
        <Select value={s.titleMode} onValueChange={(v) => update("statusLine", { titleMode: v as any })}>
          <SelectTrigger className="h-7 bg-white/5 border-white/10 text-[12px] w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="symbol">Symbol</SelectItem>
            <SelectItem value="description">Description</SelectItem>
            <SelectItem value="ticker">Ticker</SelectItem>
          </SelectContent>
        </Select>
      </CheckRow>
      <CheckRow label="Open market status" checked={s.openMarketStatus} onChange={(v) => update("statusLine", { openMarketStatus: v })} />
      <CheckRow label="Chart values" checked={s.chartValues} onChange={(v) => update("statusLine", { chartValues: v })} />
      <CheckRow label="Bar change values" checked={s.barChangeValues} onChange={(v) => update("statusLine", { barChangeValues: v })} />
      <CheckRow label="Volume" checked={s.volume} onChange={(v) => update("statusLine", { volume: v })} />
      <CheckRow label="Last day change values" checked={s.lastDayChangeValues} onChange={(v) => update("statusLine", { lastDayChangeValues: v })} />

      <SectionHeader>Indicators</SectionHeader>
      <CheckRow label="Titles" checked={s.indicatorTitles} onChange={(v) => update("statusLine", { indicatorTitles: v })} />
      <div className="pl-7">
        <CheckRow label="Inputs" checked={s.indicatorInputs} onChange={(v) => update("statusLine", { indicatorInputs: v })} />
      </div>
      <CheckRow label="Values" checked={s.indicatorValues} onChange={(v) => update("statusLine", { indicatorValues: v })} />
      <CheckRow label="Background" checked={s.indicatorBackground} onChange={(v) => update("statusLine", { indicatorBackground: v })}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={s.indicatorBackgroundOpacity}
          onChange={(e) => update("statusLine", { indicatorBackgroundOpacity: parseFloat(e.target.value) })}
          className="w-32 accent-cyan-500"
        />
      </CheckRow>
    </div>
  );
}

function ScalesPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.scalesAndLines;
  return (
    <div>
      <SectionHeader>Price scale</SectionHeader>
      <Row label="Currency and Unit">
        <Select value={s.currencyAndUnit} onValueChange={(v) => update("scalesAndLines", { currencyAndUnit: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always visible</SelectItem>
            <SelectItem value="mouseover">Visible on mouse over</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Scale modes (A and L)">
        <Select value={s.scaleModes} onValueChange={(v) => update("scalesAndLines", { scaleModes: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always visible</SelectItem>
            <SelectItem value="mouseover">Visible on mouse over</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <CheckRow label="Lock price to bar ratio" checked={s.lockPriceToBarRatio} onChange={(v) => update("scalesAndLines", { lockPriceToBarRatio: v })}>
        <Input
          type="number"
          step="0.0001"
          value={s.priceBarRatio}
          onChange={(e) => update("scalesAndLines", { priceBarRatio: parseFloat(e.target.value) || 0 })}
          className="h-7 w-28 bg-white/5 border-white/10 text-[12px]"
          disabled={!s.lockPriceToBarRatio}
        />
      </CheckRow>
      <Row label="Scales placement">
        <Select value={s.scalesPlacement} onValueChange={(v) => update("scalesAndLines", { scalesPlacement: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="right">Right</SelectItem>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <SectionHeader>Price labels &amp; lines</SectionHeader>
      <CheckRow label="No overlapping labels" checked={s.noOverlappingLabels} onChange={(v) => update("scalesAndLines", { noOverlappingLabels: v })} />
      <CheckRow label="Plus button" checked={s.plusButton} onChange={(v) => update("scalesAndLines", { plusButton: v })} />
      <CheckRow label="Countdown to bar close" checked={s.countdownToBarClose} onChange={(v) => update("scalesAndLines", { countdownToBarClose: v })} />

      <Row label="Symbol">
        <Select value={s.symbolLabelStyle} onValueChange={(v) => update("scalesAndLines", { symbolLabelStyle: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="value">Value</SelectItem>
            <SelectItem value="value_line">Value, line</SelectItem>
            <SelectItem value="label_line">Label, line</SelectItem>
            <SelectItem value="marker">Marker</SelectItem>
          </SelectContent>
        </Select>
        <ColorSwatch value={s.symbolLabelColor} onChange={(c) => update("scalesAndLines", { symbolLabelColor: c })} />
      </Row>
      <Row label="Previous day close">
        <Select value={s.previousDayClose} onValueChange={(v) => update("scalesAndLines", { previousDayClose: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="value_line">Value, line</SelectItem>
            <SelectItem value="value">Value</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Indicators and financials">
        <Select value={s.indicatorsAndFinancials} onValueChange={(v) => update("scalesAndLines", { indicatorsAndFinancials: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="value_line">Value, line</SelectItem>
            <SelectItem value="value">Value</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="High and low">
        <Select value={s.highAndLow} onValueChange={(v) => update("scalesAndLines", { highAndLow: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="label_line">Label, line</SelectItem>
            <SelectItem value="marker">Marker</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Bid and ask">
        <Select value={s.bidAndAsk} onValueChange={(v) => update("scalesAndLines", { bidAndAsk: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden</SelectItem>
            <SelectItem value="value_line">Value, line</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <SectionHeader>Time scale</SectionHeader>
      <CheckRow label="Day of week on labels" checked={s.dayOfWeekOnLabels} onChange={(v) => update("scalesAndLines", { dayOfWeekOnLabels: v })} />
    </div>
  );
}

function CanvasPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.canvas;
  return (
    <div>
      <SectionHeader>Chart basic styles</SectionHeader>
      <Row label="Background">
        <Select value="solid" onValueChange={() => {}}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-32"><SelectValue placeholder="Solid" /></SelectTrigger>
          <SelectContent><SelectItem value="solid">Solid</SelectItem></SelectContent>
        </Select>
        <ColorSwatch value={s.background} onChange={(c) => update("canvas", { background: c })} />
      </Row>
      <Row label="Grid lines">
        <Select value={s.gridLines} onValueChange={(v) => update("canvas", { gridLines: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="horizontal">Horizontal</SelectItem>
            <SelectItem value="vertical">Vertical</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <ColorSwatch value={s.gridColor.startsWith("#") ? s.gridColor : "#404040"} onChange={(c) => update("canvas", { gridColor: c })} />
      </Row>
      <Row label="Pane separators">
        <ColorSwatch value={s.paneSeparators} onChange={(c) => update("canvas", { paneSeparators: c })} />
      </Row>
      <Row label="Crosshair">
        <ColorSwatch value={s.crosshairColor} onChange={(c) => update("canvas", { crosshairColor: c })} />
        <Select value={s.crosshairStyle} onValueChange={(v) => update("canvas", { crosshairStyle: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Watermark">
        <Select value={s.watermark} onValueChange={(v) => update("canvas", { watermark: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="symbol">Symbol</SelectItem>
            <SelectItem value="replay">Replay mode</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <SectionHeader>Scales</SectionHeader>
      <Row label="Text">
        <ColorSwatch value={s.scalesTextColor.startsWith("#") ? s.scalesTextColor : "#a0afd2"} onChange={(c) => update("canvas", { scalesTextColor: c })} />
        <Select value={String(s.scalesTextSize)} onValueChange={(v) => update("canvas", { scalesTextSize: parseInt(v, 10) })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-20"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[9, 10, 11, 12, 13, 14, 16].map((sz) => <SelectItem key={sz} value={String(sz)}>{sz}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Lines">
        <ColorSwatch value={s.scalesLineColor.startsWith("#") ? s.scalesLineColor : "#404060"} onChange={(c) => update("canvas", { scalesLineColor: c })} />
      </Row>

      <SectionHeader>Buttons</SectionHeader>
      <Row label="Navigation">
        <Select value={s.navigationButtons} onValueChange={(v) => update("canvas", { navigationButtons: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="mouseover">Visible on mouse over</SelectItem>
            <SelectItem value="always">Always visible</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Pane">
        <Select value={s.paneButtons} onValueChange={(v) => update("canvas", { paneButtons: v as any })}>
          <SelectTrigger className="h-8 bg-white/5 border-white/10 text-[13px] w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="mouseover">Visible on mouse over</SelectItem>
            <SelectItem value="always">Always visible</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      <SectionHeader>Margins</SectionHeader>
      <Row label="Top">
        <Input type="number" min={0} max={50} value={s.marginTop} onChange={(e) => update("canvas", { marginTop: parseInt(e.target.value, 10) || 0 })} className="h-8 w-20 bg-white/5 border-white/10 text-[13px]" />
        <span className="text-white/50 text-xs">%</span>
      </Row>
      <Row label="Bottom">
        <Input type="number" min={0} max={50} value={s.marginBottom} onChange={(e) => update("canvas", { marginBottom: parseInt(e.target.value, 10) || 0 })} className="h-8 w-20 bg-white/5 border-white/10 text-[13px]" />
        <span className="text-white/50 text-xs">%</span>
      </Row>
      <Row label="Right">
        <Input type="number" min={0} max={100} value={s.marginRight} onChange={(e) => update("canvas", { marginRight: parseInt(e.target.value, 10) || 0 })} className="h-8 w-20 bg-white/5 border-white/10 text-[13px]" />
        <span className="text-white/50 text-xs">bars</span>
      </Row>
    </div>
  );
}

function TradingPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.trading;
  return (
    <div>
      <SectionHeader>Trading</SectionHeader>
      <CheckRow label="Enable trading from chart" checked={s.tradingEnabled} onChange={(v) => update("trading", { tradingEnabled: v })} />
      <CheckRow label="Show orders" checked={s.showOrders} onChange={(v) => update("trading", { showOrders: v })} />
      <CheckRow label="Show positions" checked={s.showPositions} onChange={(v) => update("trading", { showPositions: v })} />
      <CheckRow label="Show executions" checked={s.showExecutions} onChange={(v) => update("trading", { showExecutions: v })} />
      <CheckRow label="Show buy/sell buttons" checked={s.showBuySellButtons} onChange={(v) => update("trading", { showBuySellButtons: v })} />
      <p className="text-[11px] text-white/40 mt-4 italic">Note: trading from chart is not yet supported in THERMAL.</p>
    </div>
  );
}

function AlertsPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.alerts;
  return (
    <div>
      <SectionHeader>Alerts</SectionHeader>
      <CheckRow label="Show alert labels" checked={s.showAlertLabels} onChange={(v) => update("alerts", { showAlertLabels: v })} />
      <CheckRow label="Show alert lines" checked={s.showAlertLines} onChange={(v) => update("alerts", { showAlertLines: v })} />
      <CheckRow label="Sound on trigger" checked={s.soundEnabled} onChange={(v) => update("alerts", { soundEnabled: v })} />
      <p className="text-[11px] text-white/40 mt-4 italic">Note: chart alerts are not yet wired up in THERMAL.</p>
    </div>
  );
}

function EventsPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.events;
  return (
    <div>
      <SectionHeader>Events</SectionHeader>
      <CheckRow label="Ideas" checked={s.ideas} onChange={(v) => update("events", { ideas: v })}>
        <Select value="all" onValueChange={() => {}} disabled={!s.ideas}>
          <SelectTrigger className="h-7 bg-white/5 border-white/10 text-[12px] w-28"><SelectValue placeholder="All ideas" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All ideas</SelectItem></SelectContent>
        </Select>
      </CheckRow>
      <CheckRow label="Session breaks" checked={s.sessionBreaks} onChange={(v) => update("events", { sessionBreaks: v })}>
        <ColorSwatch value={s.sessionBreaksColor} onChange={(c) => update("events", { sessionBreaksColor: c })} />
      </CheckRow>
      <CheckRow label="Economic events" checked={s.economicEvents} onChange={(v) => update("events", { economicEvents: v })} />
      <div className="pl-7">
        <CheckRow label="Only future events" checked={s.onlyFutureEvents} onChange={(v) => update("events", { onlyFutureEvents: v })} />
        <CheckRow label="Events breaks" checked={s.eventsBreaks} onChange={(v) => update("events", { eventsBreaks: v })}>
          <ColorSwatch value={s.eventsBreaksColor} onChange={(c) => update("events", { eventsBreaksColor: c })} />
        </CheckRow>
      </div>
      <CheckRow label="Latest news" checked={s.latestNews} onChange={(v) => update("events", { latestNews: v })} />
      <CheckRow label="News notification" checked={s.newsNotification} onChange={(v) => update("events", { newsNotification: v })} />
    </div>
  );
}

function LevelPresetCards() {
  const { activeLevelPreset, applyPreset } = useChartSettings();
  return (
    <div data-testid="level-presets" className="px-3 pb-2">
      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Level display preset"
      >
        {LEVEL_PRESETS.map((preset) => {
          const isActive = activeLevelPreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              data-testid={`level-preset-${preset.id}`}
              data-preset-active={isActive ? "true" : "false"}
              onClick={() => applyPreset(preset.id as LevelPresetId)}
              className={
                "text-left rounded-md border p-2.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 " +
                (isActive
                  ? "border-cyan-400/70 bg-cyan-400/10 ring-1 ring-cyan-400/40"
                  : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    "text-[12px] font-semibold tracking-wide " +
                    (isActive ? "text-cyan-200" : "text-white/85")
                  }
                >
                  {preset.label}
                </span>
                <span
                  className={
                    "text-[10px] font-mono tabular-nums " +
                    (isActive ? "text-cyan-300/80" : "text-white/35")
                  }
                >
                  {preset.estimatedRange}
                </span>
              </div>
              <p className="text-[11px] text-white/55 leading-snug mt-1">
                {preset.description}
              </p>
            </button>
          );
        })}
      </div>
      <div
        className="mt-2 text-[11px] text-white/50 flex items-center gap-2"
        data-testid="level-preset-status"
        data-active-preset={activeLevelPreset}
      >
        {activeLevelPreset === "custom" ? (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400/80" />
            <span>
              <span className="text-amber-300/90 font-medium">Custom</span> — your
              tweaks below have diverged from a preset. Pick one to reset.
            </span>
          </>
        ) : (
          <>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400/80" />
            <span className="text-white/55">
              Preset applied. You can still tweak any control below — it will
              switch to <span className="text-amber-300/80">Custom</span> when
              you do.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function LiquidityPanel() {
  const { settings, update } = useChartSettings();
  const s = settings.liquidity;
  const liveLevels = useLiquidityLevels();
  const hidden = Array.isArray(s.hiddenLevels) ? s.hiddenLevels : [];
  const fmtPrice = (p: number) => {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toPrecision(5);
  };
  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    fmt?: (v: number) => string,
  ) => (
    <Row label={label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-44 accent-cyan-500"
      />
      <span className="text-[12px] text-white/60 font-mono w-12 tabular-nums">
        {fmt ? fmt(value) : value}
      </span>
    </Row>
  );
  const numField = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    min = 0,
    max = 999,
  ) => (
    <Row label={label}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="h-8 bg-white/5 border-white/10 text-[13px] w-24"
      />
    </Row>
  );
  return (
    <div>
      <SectionHeader>Presets</SectionHeader>
      <LevelPresetCards />

      <SectionHeader>Visibility</SectionHeader>
      <CheckRow
        label="Show liquidity levels"
        checked={s.showLevels}
        onChange={(v) => update("liquidity", { showLevels: v })}
      />
      <div className="pl-7">
        <CheckRow
          label="Elite tier (strongest)"
          checked={s.showElite}
          onChange={(v) => update("liquidity", { showElite: v })}
        />
        <CheckRow
          label="Strong tier"
          checked={s.showStrong}
          onChange={(v) => update("liquidity", { showStrong: v })}
        />
        <CheckRow
          label="Normal tier"
          checked={s.showNormal}
          onChange={(v) => update("liquidity", { showNormal: v })}
        />
      </div>
      <CheckRow
        label="Win-rate badges"
        checked={s.showBadges}
        onChange={(v) => update("liquidity", { showBadges: v })}
      />
      <CheckRow
        label="Glow effect on strong levels"
        checked={s.glowEnabled}
        onChange={(v) => update("liquidity", { glowEnabled: v })}
      />

      <SectionHeader>Tier sizing</SectionHeader>
      {numField(
        "Elite count (top N)",
        s.eliteCount,
        (v) => update("liquidity", { eliteCount: v, strongCount: Math.max(v, s.strongCount) }),
        0,
        50,
      )}
      {numField(
        "Strong count (incl. elite)",
        s.strongCount,
        (v) => update("liquidity", { strongCount: Math.max(s.eliteCount, v) }),
        0,
        100,
      )}
      {numField("Max badges shown", s.maxBadges, (v) => update("liquidity", { maxBadges: v }), 0, 50)}

      <SectionHeader>Filtering</SectionHeader>
      {slider(
        "Min strength",
        s.minStrength,
        0,
        1,
        0.05,
        (v) => update("liquidity", { minStrength: v }),
        (v) => v.toFixed(2),
      )}
      {numField("Min touch count", s.minTouches, (v) => update("liquidity", { minTouches: v }), 0, 50)}

      <SectionHeader>Style</SectionHeader>
      {slider(
        "Opacity multiplier",
        s.opacityMultiplier,
        0.1,
        1.5,
        0.05,
        (v) => update("liquidity", { opacityMultiplier: v }),
        (v) => `${Math.round(v * 100)}%`,
      )}
      {slider(
        "Line width multiplier",
        s.lineWidthMultiplier,
        0.5,
        3,
        0.1,
        (v) => update("liquidity", { lineWidthMultiplier: v }),
        (v) => `${v.toFixed(1)}×`,
      )}
      <Row label="Line style">
        <Select
          value={s.lineStyle ?? "solid"}
          onValueChange={(v) => update("liquidity", { lineStyle: v as any })}
        >
          <SelectTrigger className="h-7 w-[140px] bg-white/5 border-white/10 text-[11px] text-white/80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] text-white/40 ml-2">
          Visual only — does not affect detection
        </span>
      </Row>
      <Row label="Color palette">
        <Select
          value={s.colorPalette ?? "default"}
          onValueChange={(v) => update("liquidity", { colorPalette: v as any })}
        >
          <SelectTrigger className="h-7 w-[140px] bg-white/5 border-white/10 text-[11px] text-white/80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default (strength)</SelectItem>
            <SelectItem value="neon">Neon</SelectItem>
            <SelectItem value="muted">Muted</SelectItem>
            <SelectItem value="monochrome">Monochrome</SelectItem>
            <SelectItem value="high-contrast">High contrast</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] text-white/40 ml-2">
          Overridden by per-side colors below
        </span>
      </Row>
      <Row label="Support color">
        <ColorSwatch
          value={s.supportColor || "#26a69a"}
          onChange={(c) => update("liquidity", { supportColor: c })}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] bg-white/5 border-white/10 text-white/70"
          onClick={() => update("liquidity", { supportColor: "" })}
        >
          Auto
        </Button>
        <span className="text-[11px] text-white/40 ml-1">
          {s.supportColor ? "Custom" : "Auto (strength-based)"}
        </span>
      </Row>
      <Row label="Resistance color">
        <ColorSwatch
          value={s.resistanceColor || "#ef5350"}
          onChange={(c) => update("liquidity", { resistanceColor: c })}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] bg-white/5 border-white/10 text-white/70"
          onClick={() => update("liquidity", { resistanceColor: "" })}
        >
          Auto
        </Button>
        <span className="text-[11px] text-white/40 ml-1">
          {s.resistanceColor ? "Custom" : "Auto (strength-based)"}
        </span>
      </Row>

      <SectionHeader>Level rating engine (9/8/7)</SectionHeader>
      <Row label="Enable rating engine">
        <Checkbox
          checked={!!s.useTierEngine}
          onCheckedChange={(v) => update("liquidity", { useTierEngine: !!v })}
        />
        <span className="text-[11px] text-white/40 ml-2">
          Re-rates levels using elite/strong/watch tiers
        </span>
      </Row>
      <Row label="Hide unrated levels">
        <Checkbox
          checked={!!s.tierEngineHideUnrated}
          onCheckedChange={(v) => update("liquidity", { tierEngineHideUnrated: !!v })}
        />
        <span className="text-[11px] text-white/40 ml-2">
          Show only 9/8/7 picks
        </span>
      </Row>
      <Row label="Show rating badges">
        <Checkbox
          checked={s.tierEngineShowBadges !== false}
          onCheckedChange={(v) => update("liquidity", { tierEngineShowBadges: !!v })}
        />
        <span className="text-[11px] text-white/40 ml-2">
          "9/10", "8/10", "7/10" pills on the right
        </span>
      </Row>

      <SectionHeader>Statistical structural levels (overlay)</SectionHeader>
      <Row label="Enable overlay">
        <Checkbox
          checked={!!settings.structuralLevels.enabled}
          onCheckedChange={(v) => update("structuralLevels", { enabled: !!v })}
        />
        <span className="text-[11px] text-white/40 ml-2">
          KDE pivots + Market Profile + quantile bands. Independent of depth levels.
        </span>
      </Row>
      {(() => {
        const bothOn =
          !!settings.structuralLevels.enabled && !!settings.liquidity.showLevels;
        const confluenceOn = bothOn && !!settings.structuralLevels.confluenceOnly;
        return (
          <>
            <Row label="Confluence only">
              <Checkbox
                checked={!!settings.structuralLevels.confluenceOnly}
                disabled={!bothOn}
                onCheckedChange={(v) =>
                  update("structuralLevels", { confluenceOnly: !!v })
                }
              />
              <span
                className={`text-[11px] ml-2 ${bothOn ? "text-white/40" : "text-white/25"}`}
              >
                {bothOn
                  ? "Only show levels where depth and structural zones overlap."
                  : "Requires both Liquidity levels and structural overlay to be on."}
              </span>
            </Row>
            <Row label="Strict side match">
              <Checkbox
                checked={!!settings.structuralLevels.confluenceStrictSide}
                disabled={!confluenceOn}
                onCheckedChange={(v) =>
                  update("structuralLevels", { confluenceStrictSide: !!v })
                }
              />
              <span
                className={`text-[11px] ml-2 ${confluenceOn ? "text-white/40" : "text-white/25"}`}
              >
                {confluenceOn
                  ? "Bids must overlap support zones; asks must overlap resistance zones."
                  : "Requires Confluence only to be on."}
              </span>
            </Row>
          </>
        );
      })()}
      <Row label="Min confidence">
        <select
          className="h-7 px-2 rounded bg-white/5 border border-white/10 text-[11px] text-white/80"
          value={settings.structuralLevels.minConfidence}
          onChange={(e) =>
            update("structuralLevels", {
              minConfidence: e.target.value as "high" | "medium" | "low",
            })
          }
        >
          <option value="low">Low (show all)</option>
          <option value="medium">Medium</option>
          <option value="high">High only</option>
        </select>
      </Row>
      <Row label="Show labels">
        <Checkbox
          checked={!!settings.structuralLevels.showLabels}
          onCheckedChange={(v) => update("structuralLevels", { showLabels: !!v })}
        />
      </Row>
      <Row label="Fill opacity">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.structuralLevels.fillOpacity}
          onChange={(e) =>
            update("structuralLevels", { fillOpacity: parseFloat(e.target.value) })
          }
          className="w-32"
        />
        <span className="text-[11px] text-white/40 ml-2">
          {Math.round(settings.structuralLevels.fillOpacity * 100)}%
        </span>
      </Row>
      <Row label="Methods">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(
            [
              ["kde-pivot-cluster", "KDE pivots"],
              ["market-profile-poc", "POC"],
              ["value-area-high", "VAH"],
              ["value-area-low", "VAL"],
              ["swing-pivot", "Swings"],
              ["quantile-band", "Quantile"],
            ] as Array<[keyof typeof settings.structuralLevels.methods, string]>
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1 text-[11px] text-white/70">
              <Checkbox
                checked={!!settings.structuralLevels.methods[key]}
                onCheckedChange={(v) =>
                  update("structuralLevels", {
                    methods: { ...settings.structuralLevels.methods, [key]: !!v },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
      </Row>
      <Row label="Line style">
        <Select
          value={(settings.structuralLevels as any).lineStyle ?? "default"}
          onValueChange={(v) => update("structuralLevels", { lineStyle: v as any })}
        >
          <SelectTrigger className="h-7 w-[140px] bg-white/5 border-white/10 text-[11px] text-white/80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default (engine)</SelectItem>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] text-white/40 ml-2">
          Visual only — engine math unchanged
        </span>
      </Row>
      <Row label="Color palette">
        <Select
          value={(settings.structuralLevels as any).colorPalette ?? "default"}
          onValueChange={(v) => update("structuralLevels", { colorPalette: v as any })}
        >
          <SelectTrigger className="h-7 w-[140px] bg-white/5 border-white/10 text-[11px] text-white/80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default (confidence)</SelectItem>
            <SelectItem value="neon">Neon</SelectItem>
            <SelectItem value="muted">Muted</SelectItem>
            <SelectItem value="monochrome">Monochrome</SelectItem>
            <SelectItem value="high-contrast">High contrast</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[11px] text-white/40 ml-2">
          Tints stroke only; band fills stay confidence-driven
        </span>
      </Row>
      <Row label="Line width">
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={(settings.structuralLevels as any).lineWidthMultiplier ?? 1}
          onChange={(e) =>
            update("structuralLevels", { lineWidthMultiplier: parseFloat(e.target.value) })
          }
          className="w-32"
        />
        <span className="text-[11px] text-white/40 ml-2">
          {((settings.structuralLevels as any).lineWidthMultiplier ?? 1).toFixed(1)}×
        </span>
      </Row>

      <SectionHeader>Visible levels ({liveLevels.length})</SectionHeader>
      <div className="px-3 pb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/50">
          Click ✕ to hide a level. Hidden: {hidden.length}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] bg-white/5 border-white/10 text-white/70"
          disabled={hidden.length === 0}
          onClick={() => update("liquidity", { hiddenLevels: [] })}
        >
          Restore all
        </Button>
      </div>
      <div className="mx-3 mb-3 max-h-64 overflow-y-auto border border-white/10 rounded bg-black/30">
        {liveLevels.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-white/40 text-center">
            No levels currently visible.
          </div>
        ) : (
          [...liveLevels]
            .sort((a, b) => b.price - a.price)
            .map((lvl) => {
              const tierColor =
                lvl.tier === "elite"
                  ? "text-amber-400"
                  : lvl.tier === "strong"
                  ? "text-cyan-300"
                  : "text-white/50";
              const sideColor = lvl.isBid ? "text-emerald-400" : "text-rose-400";
              return (
                <div
                  key={`${lvl.price}-${lvl.isBid}`}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/5 hover:bg-white/5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-[11px] uppercase font-bold w-12 ${tierColor}`}>
                      {lvl.tier}
                    </span>
                    <span className={`text-[11px] font-bold w-10 ${sideColor}`}>
                      {lvl.isBid ? "BID" : "ASK"}
                    </span>
                    <span className="font-mono text-[13px] text-white tabular-nums">
                      {fmtPrice(lvl.price)}
                    </span>
                    <span className="text-[11px] text-white/40 tabular-nums">
                      str {(lvl.strength * 100).toFixed(0)}%
                    </span>
                    <span className="text-[11px] text-white/40 tabular-nums">
                      ×{lvl.touchCount}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="h-6 w-6 flex items-center justify-center rounded text-white/50 hover:text-rose-400 hover:bg-rose-500/10 text-sm"
                    title="Hide this level"
                    onClick={() =>
                      update("liquidity", {
                        hiddenLevels: [...hidden, lvl.price],
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
              );
            })
        )}
      </div>
      {hidden.length > 0 && (
        <>
          <SectionHeader>Hidden levels ({hidden.length})</SectionHeader>
          <div className="mx-3 mb-3 max-h-40 overflow-y-auto border border-white/10 rounded bg-black/30">
            {[...hidden]
              .sort((a, b) => b - a)
              .map((p) => (
                <div
                  key={p}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/5 hover:bg-white/5"
                >
                  <span className="font-mono text-[12px] text-white/60 tabular-nums">
                    {fmtPrice(p)}
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-cyan-400 hover:text-cyan-300"
                    onClick={() =>
                      update("liquidity", {
                        hiddenLevels: hidden.filter((h) => h !== p),
                      })
                    }
                  >
                    Restore
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

const PANELS: Record<SectionKey, () => React.ReactElement> = {
  symbol: SymbolPanel,
  liquidity: LiquidityPanel,
  statusLine: StatusLinePanel,
  scalesAndLines: ScalesPanel,
  canvas: CanvasPanel,
  trading: TradingPanel,
  alerts: AlertsPanel,
  events: EventsPanel,
};

export function ChartSettingsDialog() {
  const { open, setOpen, initialSection, reset } = useChartSettings();
  const [active, setActive] = useState<SectionKey>("symbol");

  useEffect(() => {
    if (open && initialSection) setActive(initialSection);
  }, [open, initialSection]);

  const Panel = PANELS[active];

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogContent
        className="w-[calc(100vw-1rem)] sm:w-auto max-w-[720px] max-h-[90vh] p-0 bg-[#1a1d2e] border border-white/10 text-white gap-0 shadow-2xl flex flex-col"
        onContextMenu={(e) => e.preventDefault()}
        onInteractOutside={() => setOpen(false)}
      >
        <DialogTitle className="sr-only">Chart settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure chart appearance, structural levels, liquidity overlays, alerts, and other preferences.
        </DialogDescription>
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/10 shrink-0">
          <div className="text-[15px] font-semibold">Settings</div>
          <button
            onClick={() => setOpen(false)}
            className="text-white/50 hover:text-white p-1"
            aria-label="Close settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Mobile: horizontally scrollable section pills above the panel.
            Desktop (sm+): vertical sidebar layout. */}
        <div className="sm:hidden border-b border-white/10 overflow-x-auto">
          <div className="flex gap-1 px-2 py-1.5 min-w-max">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const isActive = active === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setActive(s.key)}
                  className={`flex items-center gap-1.5 px-3.5 h-10 text-[13px] rounded-md whitespace-nowrap transition-colors border-b-2 ${
                    isActive
                      ? "bg-cyan-400/15 text-cyan-200 border-cyan-400"
                      : "text-white/70 hover:text-white hover:bg-white/[0.05] border-transparent"
                  }`}
                >
                  <Icon className="w-4 h-4 opacity-80" />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid sm:grid-cols-[180px_1fr] min-h-0 flex-1">
          <div className="hidden sm:block border-r border-white/10 py-2 overflow-y-auto">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const isActive = active === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setActive(s.key)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-[13px] text-left transition-colors ${
                    isActive
                      ? "bg-white/5 text-white border-l-2 border-cyan-400"
                      : "text-white/70 hover:text-white hover:bg-white/[0.03] border-l-2 border-transparent"
                  }`}
                >
                  <Icon className="w-4 h-4 opacity-80" />
                  {s.label}
                </button>
              );
            })}
          </div>
          <div className="px-4 sm:px-5 py-3 overflow-y-auto max-h-[60vh] min-h-[280px]">
            <Panel />
          </div>
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t border-white/10">
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="bg-transparent border-white/15 text-white/80 hover:bg-white/5 hover:text-white text-[12px] h-8"
          >
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              className="bg-transparent border-white/15 text-white/80 hover:bg-white/5 hover:text-white text-[12px] h-8 px-4"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => setOpen(false)}
              className="bg-white text-black hover:bg-white/90 text-[12px] h-8 px-5"
            >
              Ok
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { DEFAULT_SETTINGS };
