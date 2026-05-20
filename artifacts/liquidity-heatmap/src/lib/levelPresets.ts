import presetData from "./levelPresets.data.json";
import type { ChartSettings } from "./chartSettings";

export type LevelPresetId = "balanced" | "confluence" | "active" | "minimal";
export type ActiveLevelPreset = LevelPresetId | "custom";

export interface LevelPreset {
  id: LevelPresetId;
  label: string;
  shortLabel: string;
  description: string;
  estimatedRange: string;
  values: {
    liquidity: Partial<ChartSettings["liquidity"]>;
    structuralLevels: Partial<Omit<ChartSettings["structuralLevels"], "methods">> & {
      methods?: ChartSettings["structuralLevels"]["methods"];
    };
  };
}

const RAW_PRESETS = presetData.presets as LevelPreset[];
const PRESET_BY_ID = new Map<LevelPresetId, LevelPreset>(
  RAW_PRESETS.map((p) => [p.id, p]),
);

export const LEVEL_PRESETS: ReadonlyArray<LevelPreset> = RAW_PRESETS;
export const DEFAULT_LEVEL_PRESET: LevelPresetId = presetData.defaultPreset as LevelPresetId;

export function getLevelPreset(id: LevelPresetId): LevelPreset | undefined {
  return PRESET_BY_ID.get(id);
}

// Apply a preset to a settings object as a partial overlay on the
// `liquidity` and `structuralLevels` sections. All other sections
// (canvas, statusLine, indicators, etc.) are untouched. Returns a NEW
// settings object so React state diffing works correctly.
export function applyLevelPreset(
  settings: ChartSettings,
  id: LevelPresetId,
): ChartSettings {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) return settings;
  const liq = preset.values.liquidity ?? {};
  const sl = preset.values.structuralLevels ?? {};
  return {
    ...settings,
    liquidity: { ...settings.liquidity, ...liq },
    structuralLevels: {
      ...settings.structuralLevels,
      ...sl,
      methods: sl.methods
        ? { ...settings.structuralLevels.methods, ...sl.methods }
        : settings.structuralLevels.methods,
    },
  };
}

// Detect which preset (if any) the current settings match. Compares
// ONLY the keys each preset controls — unrelated chart settings cannot
// flip the active state to "custom". Returns "custom" if no preset's
// controlled keys all match.
export function detectActiveLevelPreset(settings: ChartSettings): ActiveLevelPreset {
  for (const preset of RAW_PRESETS) {
    if (matchesPreset(settings, preset)) return preset.id;
  }
  return "custom";
}

function matchesPreset(settings: ChartSettings, preset: LevelPreset): boolean {
  const liq = preset.values.liquidity ?? {};
  for (const key of Object.keys(liq) as (keyof ChartSettings["liquidity"])[]) {
    if (!shallowEqual(settings.liquidity[key], (liq as any)[key])) return false;
  }
  const sl = preset.values.structuralLevels ?? {};
  for (const key of Object.keys(sl) as (keyof typeof sl)[]) {
    if (key === "methods") continue;
    if (!shallowEqual((settings.structuralLevels as any)[key], (sl as any)[key])) return false;
  }
  if (sl.methods) {
    for (const m of Object.keys(sl.methods) as (keyof ChartSettings["structuralLevels"]["methods"])[]) {
      if (settings.structuralLevels.methods[m] !== sl.methods[m]) return false;
    }
  }
  return true;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") {
    // Tolerate JSON round-trip drift on floats (e.g. 0.45 vs 0.45000000001).
    return Math.abs(a - b) < 1e-9;
  }
  return false;
}

// Returns the union of all setting keys any preset controls. Useful
// for telling the UI which knobs are "preset-driven" so we can warn
// users that a Custom preset state means they've diverged.
export function presetControlledKeys(): {
  liquidity: ReadonlyArray<keyof ChartSettings["liquidity"]>;
  structuralLevels: ReadonlyArray<keyof Omit<ChartSettings["structuralLevels"], "methods">>;
  methods: ReadonlyArray<keyof ChartSettings["structuralLevels"]["methods"]>;
} {
  const liq = new Set<keyof ChartSettings["liquidity"]>();
  const sl = new Set<keyof Omit<ChartSettings["structuralLevels"], "methods">>();
  const methods = new Set<keyof ChartSettings["structuralLevels"]["methods"]>();
  for (const p of RAW_PRESETS) {
    for (const k of Object.keys(p.values.liquidity ?? {}) as any) liq.add(k);
    for (const k of Object.keys(p.values.structuralLevels ?? {}) as any) {
      if (k !== "methods") sl.add(k);
    }
    for (const k of Object.keys(p.values.structuralLevels?.methods ?? {}) as any) methods.add(k);
  }
  return {
    liquidity: Array.from(liq),
    structuralLevels: Array.from(sl),
    methods: Array.from(methods),
  };
}
