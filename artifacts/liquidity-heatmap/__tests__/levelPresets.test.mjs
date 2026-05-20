// Level-display preset behaviour. These tests pin:
//   1. preset values are read from the JSON source of truth and not
//      drifting from a hand-written copy in this file
//   2. applying a preset writes only liquidity + structuralLevels keys
//      (no other section is mutated)
//   3. active-preset detection compares ONLY preset-controlled keys —
//      changing an unrelated section (e.g. canvas.background) must NOT
//      flip the state to "custom"
//   4. mutating any preset-controlled key after apply does flip to
//      "custom"
//   5. apply is idempotent (apply twice = apply once)
//   6. the four expected presets exist with the expected ids
//   7. preset module is display-layer only — it cannot transitively
//      import anything from the api-server/services/engines/ tree
//
// We mirror the apply / detect helpers inline (the same pattern used
// by legacyFallback.test.mjs) so the test stays a pure node:test
// runner with no TypeScript toolchain. The DATA itself is loaded from
// the same JSON file the TS code uses, eliminating the drift risk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PRESET_DATA_PATH = resolve(REPO_ROOT, "src/lib/levelPresets.data.json");
const PRESET_TS_PATH = resolve(REPO_ROOT, "src/lib/levelPresets.ts");
const CHART_SETTINGS_PATH = resolve(REPO_ROOT, "src/lib/chartSettings.tsx");

const presetData = JSON.parse(await readFile(PRESET_DATA_PATH, "utf8"));
const PRESETS = presetData.presets;

// ────────────────────────────────────────────────────────────
// Inline mirror of the apply / detect helpers. Source of truth is
// src/lib/levelPresets.ts; this mirror exists to keep the test runner
// dependency-free.
function applyLevelPreset(settings, id) {
  const preset = PRESETS.find((p) => p.id === id);
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

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  return false;
}

function matchesPreset(settings, preset) {
  const liq = preset.values.liquidity ?? {};
  for (const key of Object.keys(liq)) {
    if (!shallowEqual(settings.liquidity[key], liq[key])) return false;
  }
  const sl = preset.values.structuralLevels ?? {};
  for (const key of Object.keys(sl)) {
    if (key === "methods") continue;
    if (!shallowEqual(settings.structuralLevels[key], sl[key])) return false;
  }
  if (sl.methods) {
    for (const m of Object.keys(sl.methods)) {
      if (settings.structuralLevels.methods[m] !== sl.methods[m]) return false;
    }
  }
  return true;
}

function detectActiveLevelPreset(settings) {
  for (const preset of PRESETS) {
    if (matchesPreset(settings, preset)) return preset.id;
  }
  return "custom";
}

// Minimal stand-in for ChartSettings shape — only the sections presets
// touch + a couple of unrelated sections we use to prove non-interference.
function makeBaseSettings() {
  return {
    canvas: { background: "#0c0c1d", marginTop: 7 },
    statusLine: { logo: true, title: true },
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
      colorPalette: "default",
    },
    structuralLevels: {
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
      colorPalette: "default",
      lineWidthMultiplier: 1,
    },
  };
}

// ────────────────────────────────────────────────────────────
// Tests
test("preset table: contract — exactly four presets, expected ids, default = balanced", () => {
  const ids = PRESETS.map((p) => p.id).sort();
  assert.deepEqual(ids, ["active", "balanced", "confluence", "minimal"]);
  assert.equal(presetData.defaultPreset, "balanced");
  for (const p of PRESETS) {
    assert.ok(p.label && p.description && p.estimatedRange,
      `preset ${p.id} missing label/description/estimatedRange`);
    assert.ok(p.values?.liquidity && p.values?.structuralLevels,
      `preset ${p.id} missing values.liquidity / values.structuralLevels`);
  }
});

test("preset table: every controlled key exists on the live ChartSettings shape", async () => {
  const tsx = await readFile(CHART_SETTINGS_PATH, "utf8");
  const liqKeys = Array.from(tsx.matchAll(/^\s{2}liquidity:\s*{([\s\S]*?)^\s{2}};?$/gm))
    .flatMap((m) => Array.from(m[1].matchAll(/^\s{4}(\w+):/gm)).map((mm) => mm[1]));
  const slKeys = Array.from(tsx.matchAll(/^\s{2}structuralLevels:\s*{([\s\S]*?)^\s{2}};?$/gm))
    .flatMap((m) => Array.from(m[1].matchAll(/^\s{4}(\w+):/gm)).map((mm) => mm[1]));
  for (const p of PRESETS) {
    for (const k of Object.keys(p.values.liquidity ?? {})) {
      assert.ok(liqKeys.includes(k),
        `preset ${p.id} writes liquidity.${k} but no such field exists in ChartSettings.liquidity`);
    }
    for (const k of Object.keys(p.values.structuralLevels ?? {})) {
      assert.ok(slKeys.includes(k),
        `preset ${p.id} writes structuralLevels.${k} but no such field exists in ChartSettings.structuralLevels`);
    }
  }
});

test("apply: writes only liquidity + structuralLevels — other sections untouched", () => {
  for (const p of PRESETS) {
    const base = makeBaseSettings();
    const out = applyLevelPreset(base, p.id);
    assert.deepEqual(out.canvas, base.canvas, `preset ${p.id} mutated canvas section`);
    assert.deepEqual(out.statusLine, base.statusLine, `preset ${p.id} mutated statusLine section`);
  }
});

test("apply: idempotent — applying twice produces the same object shape as applying once", () => {
  for (const p of PRESETS) {
    const base = makeBaseSettings();
    const once = applyLevelPreset(base, p.id);
    const twice = applyLevelPreset(once, p.id);
    assert.deepEqual(once.liquidity, twice.liquidity);
    assert.deepEqual(once.structuralLevels, twice.structuralLevels);
  }
});

test("detect: each preset id round-trips through apply→detect", () => {
  for (const p of PRESETS) {
    const base = makeBaseSettings();
    const applied = applyLevelPreset(base, p.id);
    const detected = detectActiveLevelPreset(applied);
    assert.equal(detected, p.id, `apply(${p.id}) did not detect as ${p.id}`);
  }
});

test("detect: presets are mutually exclusive — no cross-detection", () => {
  for (const target of PRESETS) {
    const applied = applyLevelPreset(makeBaseSettings(), target.id);
    const detected = detectActiveLevelPreset(applied);
    assert.equal(detected, target.id);
  }
});

test("detect: unrelated section change does NOT flip to custom", () => {
  for (const p of PRESETS) {
    const applied = applyLevelPreset(makeBaseSettings(), p.id);
    // Mutate canvas + statusLine — neither is preset-controlled.
    applied.canvas = { ...applied.canvas, background: "#ff00ff" };
    applied.statusLine = { ...applied.statusLine, logo: false };
    assert.equal(detectActiveLevelPreset(applied), p.id,
      `unrelated mutation flipped ${p.id} to custom`);
  }
});

test("detect: also untouched fields inside liquidity/structural sections do not flip preset", () => {
  // hiddenLevels and supportColor are in `liquidity` but no preset
  // controls them — user can hide a level without losing their preset.
  const applied = applyLevelPreset(makeBaseSettings(), "balanced");
  applied.liquidity.hiddenLevels = [70000, 75000];
  applied.liquidity.supportColor = "#ff00ff";
  assert.equal(detectActiveLevelPreset(applied), "balanced");
});

test("detect: changing any preset-controlled key flips to custom", () => {
  const controlled = [
    ["liquidity", "minStrength", 0.99],
    ["liquidity", "eliteCount", 1],
    ["liquidity", "showStrong", false],
    ["liquidity", "tierEngineHideUnrated", false],
    ["structuralLevels", "minConfidence", "low"],
    ["structuralLevels", "confluenceOnly", true],
    ["structuralLevels", "showLabels", false],
  ];
  for (const [section, key, value] of controlled) {
    const applied = applyLevelPreset(makeBaseSettings(), "balanced");
    applied[section] = { ...applied[section], [key]: value };
    assert.equal(detectActiveLevelPreset(applied), "custom",
      `mutating ${section}.${key} did not flip to custom`);
  }
});

test("detect: changing any structural method flips to custom", () => {
  const applied = applyLevelPreset(makeBaseSettings(), "balanced");
  applied.structuralLevels.methods = { ...applied.structuralLevels.methods, "swing-pivot": false };
  assert.equal(detectActiveLevelPreset(applied), "custom");
});

test("detect: a base settings object that matches no preset reports custom", () => {
  // Default settings have minStrength=0, minTouches=0, useTierEngine=false —
  // doesn't match any preset (all of them set useTierEngine=true).
  const base = makeBaseSettings();
  assert.equal(detectActiveLevelPreset(base), "custom");
});

test("guardrail: preset module imports nothing from api-server/services/engines", async () => {
  const ts = await readFile(PRESET_TS_PATH, "utf8");
  // Pull out actual import / require / dynamic-import target strings —
  // we don't care what the file's comments / type names happen to say,
  // only whether code is reaching into engine territory.
  const importTargets = [
    ...ts.matchAll(/^\s*import[^"']*from\s*["']([^"']+)["']/gm),
    ...ts.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
    ...ts.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((m) => m[1]);
  const forbidden = [
    /api-server/,
    /services\/engines/,
    /\bengines\//,
    /scoring/,
    /confluence(\.ts)?$/,
    /levelRegistry/,
    /^\.\.\/\.\.\/\.\.\//, // any climb out of artifacts/liquidity-heatmap/
  ];
  for (const target of importTargets) {
    for (const re of forbidden) {
      assert.equal(re.test(target), false,
        `levelPresets.ts imports "${target}" which matches forbidden pattern ${re}`);
    }
  }
  // The JSON file is pure data — no imports are possible at all.
  // Just confirm it parses and has the expected top-level shape.
  const data = JSON.parse(await readFile(PRESET_DATA_PATH, "utf8"));
  assert.ok(Array.isArray(data.presets), "data.presets must be an array");
  assert.ok(data.defaultPreset, "data.defaultPreset must be set");
});

test("preset: balanced default keeps showLevels + structural enabled (so chart is never blank by default)", () => {
  const balanced = PRESETS.find((p) => p.id === "balanced");
  assert.equal(balanced.values.liquidity.showLevels, true);
  assert.equal(balanced.values.structuralLevels.enabled, true);
});

test("preset: confluence preset is overlap-focused but practically usable", () => {
  // The "confluence" preset's job is to surface the overlap between
  // structural zones and liquidity lines. It must keep its liquidity
  // knobs stricter than balanced (fewer, stronger lines), AND it must
  // turn confluenceOnly on. But two earlier guardrails — minConfidence
  // pinned to "high" and confluenceStrictSide forced on — produced
  // frequent zero-result renders on real BTC/ETH 4H data. The preset
  // is now tuned to be precise without collapsing to nothing:
  //   • minConfidence = "medium"  (not "high")
  //   • confluenceStrictSide = false  (bid-under-resistance kept)
  // A small display-only price tolerance in HeatmapChart.tsx complements
  // this. Engine math is NOT touched.
  const b = PRESETS.find((p) => p.id === "balanced").values;
  const c = PRESETS.find((p) => p.id === "confluence").values;

  // Liquidity-side guardrails (still stricter than balanced).
  assert.ok(c.liquidity.minStrength > b.liquidity.minStrength,
    "confluence.minStrength should be > balanced.minStrength");
  assert.ok(c.liquidity.minTouches >= b.liquidity.minTouches,
    "confluence.minTouches should be >= balanced.minTouches");
  assert.ok(c.liquidity.eliteCount < b.liquidity.eliteCount,
    "confluence.eliteCount should be < balanced.eliteCount");

  // The point of the preset.
  assert.equal(c.structuralLevels.confluenceOnly, true,
    "confluence preset must turn confluenceOnly on");

  // Usability guardrails — these are the regressions we just fixed and
  // do not want to silently slip back to "high" / strict-side.
  assert.equal(c.structuralLevels.minConfidence, "medium",
    "confluence preset must use minConfidence='medium' so the overlap " +
    "filter has a workable number of zones to match against; 'high' is " +
    "too aggressive on BTC/ETH 4H and produced zero-result renders.");
  assert.equal(c.structuralLevels.confluenceStrictSide, false,
    "confluence preset must keep confluenceStrictSide off so common " +
    "real setups (e.g. bid liquidity sitting under a resistance zone) " +
    "are not silently dropped from the overlap.");
});

test("preset: active preset shows more setups than balanced (loosens knobs)", () => {
  const b = PRESETS.find((p) => p.id === "balanced").values;
  const a = PRESETS.find((p) => p.id === "active").values;
  assert.ok(a.liquidity.minStrength < b.liquidity.minStrength,
    "active.minStrength should be < balanced.minStrength");
  assert.ok(a.liquidity.minTouches <= b.liquidity.minTouches,
    "active.minTouches should be <= balanced.minTouches");
  assert.equal(a.liquidity.showNormal, true,
    "active should include normal-tier levels");
  assert.equal(a.structuralLevels.minConfidence, "low");
});

test("preset: minimal preset shows fewest levels", () => {
  const m = PRESETS.find((p) => p.id === "minimal").values;
  const b = PRESETS.find((p) => p.id === "balanced").values;
  assert.ok(m.liquidity.eliteCount <= b.liquidity.eliteCount);
  assert.equal(m.liquidity.showStrong, false);
  assert.equal(m.liquidity.showNormal, false);
  // Minimal keeps the strongest reversal methods (swing pivots +
  // quantile bands) — these are what survive in a clean view, not the
  // visually-cleanest-but-weaker methods like POC / value-area edges.
  // Cleanliness comes from showStrong=false + showNormal=false +
  // eliteCount≤6 + minConfidence=high, NOT from removing the strongest
  // structural reversal sources.
  assert.equal(m.structuralLevels.methods["swing-pivot"], true);
  assert.equal(m.structuralLevels.methods["quantile-band"], true);
  // And it stays minimal by trimming the weaker-for-reversal methods.
  assert.equal(m.structuralLevels.methods["market-profile-poc"], false);
  assert.equal(m.structuralLevels.methods["value-area-high"], false);
  assert.equal(m.structuralLevels.methods["value-area-low"], false);
});
