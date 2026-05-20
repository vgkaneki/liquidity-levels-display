import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import {
  applyLevelPreset,
  detectActiveLevelPreset,
  DEFAULT_LEVEL_PRESET,
  type ActiveLevelPreset,
  type LevelPresetId,
} from "./levelPresets";

export type CurrencyVisibility = "always" | "mouseover" | "hidden";

// Display-only overlay-line style controls (line dash + color palette).
// "solid" / "dashed" / "dotted" are explicit. For overlays whose default
// look is already a specific dash pattern (e.g. structural mid-line), the
// "default" value preserves the original engine-chosen pattern.
export type OverlayLineStyle = "default" | "solid" | "dashed" | "dotted";
export type OverlayColorPalette =
  | "default"
  | "market-blue"
  | "neon"
  | "muted"
  | "monochrome"
  | "high-contrast";

// Color palette mapping. "default" returns null so callers fall back to
// the existing per-tier / per-confidence hue logic — preserving the
// chart's current look exactly when the user hasn't picked a palette.
// Palettes are display tints only; engine math is unaffected.
export const OVERLAY_PALETTE_COLORS: Record<
  Exclude<OverlayColorPalette, "default">,
  { support: string; resistance: string }
> = {
  // marketBlueLevelColorsV1: matches the login-page Market Strategy cyan.
  "market-blue": { support: "#22d3ee", resistance: "#22d3ee" },
  neon: { support: "#00e5ff", resistance: "#ff2bd6" },
  muted: { support: "#94a3b8", resistance: "#f59e0b" },
  monochrome: { support: "#cbd5e1", resistance: "#cbd5e1" },
  "high-contrast": { support: "#ffffff", resistance: "#fde047" },
};

export function paletteColorFor(
  palette: OverlayColorPalette,
  isSupport: boolean,
): { r: number; g: number; b: number } | null {
  if (palette === "default") return null;
  const entry = OVERLAY_PALETTE_COLORS[palette];
  if (!entry) return null;
  const hex = (isSupport ? entry.support : entry.resistance).replace("#", "");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

// Translate the user-selected style into a setLineDash array. "default"
// returns null so the caller can keep its native dash pattern (e.g.
// structural mid/edges) unchanged.
export function overlayLineDash(style: OverlayLineStyle): number[] | null {
  if (style === "solid") return [];
  if (style === "dashed") return [6, 4];
  if (style === "dotted") return [2, 3];
  return null;
}

export type ScalesPlacement = "auto" | "right" | "left" | "both";
export type GridLines = "none" | "horizontal" | "vertical" | "both";
export type ButtonVisibility = "mouseover" | "always" | "hidden";
export type WatermarkMode = "off" | "symbol" | "replay";
export type TitleMode = "symbol" | "description" | "ticker";
export type LineStyle = "hidden" | "value" | "value_line" | "label_line" | "marker";
export type Precision = "default" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type PriceScaleMode = "regular" | "log" | "percent" | "auto";

export type ChartType =
  | "candles"
  | "hollow_candles"
  | "line"
  | "line_markers"
  | "step"
  | "area"
  | "hlc_area"
  | "baseline"
  | "columns"
  | "high_low";

export interface IndicatorInstance {
  id: string;
  type:
    | "sma"
    | "ema"
    | "rsi"
    | "bb"
    | "volume"
    | "macd"
    | "volume_delta"
    | "cvd"
    | "cvd_perp"
    | "fib_grid"
    | "fib_retracement"
    | "liq_heatmap"
    | "liq_heatmap_light"
    | "liq_heatmap_real"
    | "candle_close_timer"
    | "absorption_levels";
  params: Record<string, number>;
  color: string;
  pane: "overlay" | "below";
  visible?: boolean;
}

export interface ChartSettings {
  chartType: ChartType;
  indicators: IndicatorInstance[];
  symbol: {
    hollowBody: boolean;
    hollowBorders: boolean;
    hollowWick: boolean;
    upColor: string;
    downColor: string;
    borderUpColor: string;
    borderDownColor: string;
    wickUpColor: string;
    wickDownColor: string;
    precision: Precision;
    timezone: string;
  };
  statusLine: {
    logo: boolean;
    title: boolean;
    titleMode: TitleMode;
    openMarketStatus: boolean;
    chartValues: boolean;
    barChangeValues: boolean;
    volume: boolean;
    lastDayChangeValues: boolean;
    indicatorTitles: boolean;
    indicatorInputs: boolean;
    indicatorValues: boolean;
    indicatorBackground: boolean;
    indicatorBackgroundOpacity: number;
  };
  scalesAndLines: {
    currencyAndUnit: CurrencyVisibility;
    scaleModes: CurrencyVisibility;
    lockPriceToBarRatio: boolean;
    priceBarRatio: number;
    scalesPlacement: ScalesPlacement;
    noOverlappingLabels: boolean;
    plusButton: boolean;
    countdownToBarClose: boolean;
    symbolLabelStyle: LineStyle;
    symbolLabelColor: string;
    previousDayClose: LineStyle;
    indicatorsAndFinancials: LineStyle;
    highAndLow: LineStyle;
    bidAndAsk: LineStyle;
    dayOfWeekOnLabels: boolean;
  };
  canvas: {
    background: string;
    gridLines: GridLines;
    gridColor: string;
    paneSeparators: string;
    crosshairColor: string;
    crosshairStyle: "solid" | "dashed" | "dotted";
    watermark: WatermarkMode;
    scalesTextColor: string;
    scalesTextSize: number;
    scalesLineColor: string;
    navigationButtons: ButtonVisibility;
    paneButtons: ButtonVisibility;
    marginTop: number;
    marginBottom: number;
    marginRight: number;
    priceScaleMode: PriceScaleMode;
  };
  trading: {
    tradingEnabled: boolean;
    showOrders: boolean;
    showPositions: boolean;
    showExecutions: boolean;
    showBuySellButtons: boolean;
  };
  alerts: {
    showAlertLabels: boolean;
    showAlertLines: boolean;
    soundEnabled: boolean;
  };
  events: {
    ideas: boolean;
    sessionBreaks: boolean;
    sessionBreaksColor: string;
    economicEvents: boolean;
    onlyFutureEvents: boolean;
    eventsBreaks: boolean;
    eventsBreaksColor: string;
    latestNews: boolean;
    newsNotification: boolean;
  };
  liquidity: {
    showLevels: boolean;
    showElite: boolean;
    showStrong: boolean;
    showNormal: boolean;
    showBadges: boolean;
    glowEnabled: boolean;
    eliteCount: number;
    strongCount: number;
    maxBadges: number;
    minStrength: number;
    minTouches: number;
    supportColor: string;
    resistanceColor: string;
    opacityMultiplier: number;
    lineWidthMultiplier: number;
    hiddenLevels: number[];
    useTierEngine: boolean;
    tierEngineHideUnrated: boolean;
    tierEngineShowBadges: boolean;
    // Display-only style controls. "solid" preserves the chart's current
    // look. Engine math, scoring, tiering, and confluence are unaffected.
    lineStyle: OverlayLineStyle;
    colorPalette: OverlayColorPalette;
  };
  structuralLevels: {
    enabled: boolean;
    confluenceOnly: boolean;
    confluenceStrictSide: boolean;
    minConfidence: "high" | "medium" | "low";
    showLabels: boolean;
    fillOpacity: number;
    methods: {
      "kde-pivot-cluster": boolean;
      "market-profile-poc": boolean;
      "value-area-high": boolean;
      "value-area-low": boolean;
      "swing-pivot": boolean;
      "quantile-band": boolean;
    };
    // Display-only style controls. "default" preserves the engine's native
    // dash patterns ([5,4] mid-line, [2,3] band edges) and confidence-tier
    // hue mapping. Engine math is unaffected.
    lineStyle: OverlayLineStyle;
    colorPalette: OverlayColorPalette;
    lineWidthMultiplier: number;
  };
  analyticsOverlays: {
    funding: boolean;       // top-of-pane funding-rate divergence strip
    oiDelta: boolean;       // per-bucket open-interest delta heat strip
    takerPressure: boolean; // bottom-of-pane taker buy/sell ribbon
    cvd: boolean;           // real CVD line scaled into a thin sub-strip
    magnetZones: boolean;   // liquidation cluster magnet bands
  };
}

export const DEFAULT_SETTINGS: ChartSettings = {
  chartType: "candles",
  indicators: [],
  symbol: {
    hollowBody: true,
    hollowBorders: true,
    hollowWick: true,
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderUpColor: "#26a69a",
    borderDownColor: "#ef5350",
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
    precision: "default",
    timezone: "(UTC-5) Chicago",
  },
  statusLine: {
    logo: true,
    title: true,
    titleMode: "symbol",
    openMarketStatus: true,
    chartValues: true,
    barChangeValues: false,
    volume: true,
    lastDayChangeValues: false,
    indicatorTitles: true,
    indicatorInputs: true,
    indicatorValues: true,
    indicatorBackground: true,
    indicatorBackgroundOpacity: 0.5,
  },
  scalesAndLines: {
    currencyAndUnit: "always",
    scaleModes: "mouseover",
    lockPriceToBarRatio: false,
    priceBarRatio: 0.0096,
    scalesPlacement: "auto",
    noOverlappingLabels: true,
    plusButton: false,
    countdownToBarClose: true,
    // Default to a right-axis price label only. The full-width live-price
    // guide line is intentionally disabled in HeatmapChart, and this
    // setting keeps the user-visible default aligned with that behavior.
    symbolLabelStyle: "value",
    symbolLabelColor: "#26a69a",
    previousDayClose: "hidden",
    indicatorsAndFinancials: "hidden",
    highAndLow: "hidden",
    bidAndAsk: "hidden",
    dayOfWeekOnLabels: true,
  },
  canvas: {
    background: "#0c0c1d",
    gridLines: "horizontal",
    gridColor: "rgba(255,255,255,0.025)",
    paneSeparators: "#ffffff",
    crosshairColor: "#a0afd2",
    crosshairStyle: "dashed",
    watermark: "off",
    scalesTextColor: "rgba(160,175,210,0.55)",
    scalesTextSize: 11,
    scalesLineColor: "rgba(160,175,210,0.2)",
    navigationButtons: "mouseover",
    paneButtons: "mouseover",
    // Tighter default viewport spacing for a more professional, less padded
    // chart feel without crowding highs/lows or clipping the right-axis label.
    marginTop: 7,
    marginBottom: 6,
    marginRight: 7,
    priceScaleMode: "auto",
  },
  trading: {
    tradingEnabled: false,
    showOrders: true,
    showPositions: true,
    showExecutions: true,
    showBuySellButtons: false,
  },
  alerts: {
    showAlertLabels: true,
    showAlertLines: true,
    soundEnabled: false,
  },
  events: {
    ideas: false,
    sessionBreaks: false,
    sessionBreaksColor: "#3b82f6",
    economicEvents: true,
    onlyFutureEvents: true,
    eventsBreaks: false,
    eventsBreaksColor: "#6b7280",
    latestNews: true,
    newsNotification: false,
  },
  liquidity: {
    showLevels: true,
    showElite: true,
    showStrong: true,
    showNormal: true,
    showBadges: true,
    glowEnabled: true,
    eliteCount: 12,
    strongCount: 30,
    maxBadges: 12,
    minStrength: 0,
    minTouches: 0,
    supportColor: "",
    resistanceColor: "",
    opacityMultiplier: 1.25,
    lineWidthMultiplier: 1,
    hiddenLevels: [],
    useTierEngine: false,
    tierEngineHideUnrated: false,
    tierEngineShowBadges: true,
    lineStyle: "solid",
    colorPalette: "market-blue",
  },
  structuralLevels: {
    // Default ON so a fresh load shows structural zones automatically
    // (Task #68 covers this flip alongside the L2 DOM ladder; persisted
    // user settings are preserved by deepMerge in loadSettings).
    enabled: true,
    confluenceOnly: false,
    confluenceStrictSide: false,
    minConfidence: "medium",
    showLabels: true,
    fillOpacity: 0.5,
    methods: {
      "kde-pivot-cluster": true,
      "market-profile-poc": true,
      "value-area-high": true,
      "value-area-low": true,
      "swing-pivot": true,
      "quantile-band": true,
    },
    lineStyle: "default",
    colorPalette: "market-blue",
    lineWidthMultiplier: 1,
  },
  analyticsOverlays: {
    funding: false,
    oiDelta: false,
    takerPressure: false,
    cvd: false,
    magnetZones: false,
  },
};

// ────────────────────────────────────────────────────────────
// Live publication of currently visible liquidity levels.
// HeatmapChart pushes the rendered set; ChartSettingsDialog
// subscribes via useLiquidityLevels() to render a removable list.
export interface PublishedLiquidityLevel {
  price: number;
  tier: "elite" | "strong" | "normal";
  isBid: boolean;
  strength: number;
  touchCount: number;
}
let _currentLevels: PublishedLiquidityLevel[] = [];
const _levelListeners = new Set<() => void>();
export function publishLiquidityLevels(levels: PublishedLiquidityLevel[]) {
  _currentLevels = levels;
  _levelListeners.forEach((l) => l());
}
export function useLiquidityLevels(): PublishedLiquidityLevel[] {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((x) => x + 1);
    _levelListeners.add(cb);
    return () => { _levelListeners.delete(cb); };
  }, []);
  return _currentLevels;
}

const STORAGE_KEY = "thermal.chartSettings.v1";

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)[k];
    const pv = (patch as any)[k];
    if (pv !== null && typeof pv === "object" && !Array.isArray(pv) && typeof bv === "object") {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

function loadSettings(): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First-time visitors land on the recommended default preset
      // (Balanced Pro). Returning users with persisted settings keep
      // their current state untouched (handled by the deepMerge path
      // below — no preset is force-applied on top of saved state).
      return applyLevelPreset(DEFAULT_SETTINGS, DEFAULT_LEVEL_PRESET);
    }
    const parsed = JSON.parse(raw);
    // Strip deprecated keys from older persisted snapshots so they don't
    // linger as dead state inside the merged object. Add new entries here
    // whenever a settings field is removed.
    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      delete parsed.structuralLevels.maxZones;
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type SectionKey = {
  [K in keyof ChartSettings]: ChartSettings[K] extends object
    ? ChartSettings[K] extends Array<unknown>
      ? never
      : K
    : never;
}[keyof ChartSettings];

interface ChartSettingsContextValue {
  settings: ChartSettings;
  update: <K extends SectionKey>(section: K, patch: Partial<ChartSettings[K]>) => void;
  set: <K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) => void;
  reset: () => void;
  setOpen: (open: boolean) => void;
  open: boolean;
  initialSection: SectionKey | null;
  openTo: (section: SectionKey) => void;
  // Level-display presets. Pure overlay on `liquidity` and
  // `structuralLevels` sections — see ./levelPresets.ts.
  activeLevelPreset: ActiveLevelPreset;
  applyPreset: (id: LevelPresetId) => void;
}

const Ctx = createContext<ChartSettingsContextValue | null>(null);

export function ChartSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ChartSettings>(() => loadSettings());
  const [open, setOpen] = useState(false);
  const [initialSection, setInitialSection] = useState<SectionKey | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore quota errors
    }
  }, [settings]);

  const update = useCallback(<K extends SectionKey>(section: K, patch: Partial<ChartSettings[K]>) => {
    setSettings((s) => ({ ...s, [section]: { ...(s[section] as object), ...(patch as object) } as ChartSettings[K] }));
  }, []);

  const set = useCallback(<K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const openTo = useCallback((section: SectionKey) => {
    setInitialSection(section);
    setOpen(true);
  }, []);

  const applyPreset = useCallback((id: LevelPresetId) => {
    setSettings((s) => applyLevelPreset(s, id));
  }, []);

  const activeLevelPreset = useMemo<ActiveLevelPreset>(
    () => detectActiveLevelPreset(settings),
    [settings],
  );

  return (
    <Ctx.Provider
      value={{
        settings,
        update,
        set,
        reset,
        open,
        setOpen,
        initialSection,
        openTo,
        activeLevelPreset,
        applyPreset,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useChartSettings(): ChartSettingsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useChartSettings must be used within ChartSettingsProvider");
  return v;
}
