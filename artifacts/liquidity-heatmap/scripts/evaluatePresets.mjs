#!/usr/bin/env node
// Deterministic preset evaluator.
//
// Reads checked-in fixture snapshots of registry levels (liquidity) +
// structural-zones responses for BTC / ETH / SOL captured against the
// real backend, applies each preset's display filters in turn, and
// writes a markdown report with the metrics needed to compare presets:
//   - visible liquidity count    (after tier + min strength + min touches filters)
//   - visible structural count   (after minConfidence + methods filter, and
//                                  optionally `confluenceOnly`)
//   - confluence overlap count
//   - median absolute distance from current price to nearest confluence (% of price)
//   - clutter score = visible-line-count per 100 px of chart height
//
// The script is fully deterministic: same fixtures + same preset table
// = same report. Re-run after changing the preset table to refresh the
// report.
//
// USAGE:
//   node artifacts/liquidity-heatmap/scripts/evaluatePresets.mjs
//
// ─── Determinism contract (any change here invalidates past reports) ──
//   Fixture symbols .... BTCUSDT, ETHUSDT, SOLUSDT
//   Timeframe .......... 4h structural levels; registry levels are always live
//                        (no resolution dependency)
//   Visible window ..... ±5% of currentPrice  (i.e. price ∈ [P*0.95, P*1.05])
//   Chart height ....... 600 px (typical desktop)
//   Overlap rule ....... a liquidity level "overlaps" a structural zone
//                        when level.price ∈ [zone.priceLow, zone.priceHigh]
//                        expanded by ±0.15% (matches engine proximityPct)
//   Clutter score ...... totalVisibleLines * 100 / CHART_HEIGHT_PX
//                        liquidity counts as 1 line; structural counts as 2
//                        (top + bottom band edges; mid line is co-located)
//
// Engine math, scoring, confluence-merge, registry decay are NOT used or
// modified — this script reads engine output and applies only the
// display filters that already exist in the chart settings UI.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(__dirname, "..");
const PRESETS_PATH = resolve(ARTIFACT_ROOT, "src/lib/levelPresets.data.json");
const FIXTURES_DIR = resolve(ARTIFACT_ROOT, "__tests__/fixtures");
const REPORT_PATH = resolve(ARTIFACT_ROOT, "__tests__/__snapshots__/presets-evaluation.md");

const VISIBLE_WINDOW_PCT = 0.05; // ±5% of current price
const CHART_HEIGHT_PX = 600;
const OVERLAP_TOLERANCE_PCT = 0.0015; // 0.15% — matches engine proximityPct
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

// ────────────────────────────────────────────────────────────
// Load preset data
const { presets: PRESETS } = JSON.parse(await readFile(PRESETS_PATH, "utf8"));

// ────────────────────────────────────────────────────────────
// Display filters mirror the renderer's behaviour (HeatmapChart.tsx).
// We DO NOT compute strength / reliability / tier — we simply filter on
// the values the engine already produced.

function filterRegistryLevels(levels, preset, currentPrice) {
  const c = preset.values.liquidity;
  if (!c.showLevels) return [];
  const inWindow = (l) =>
    Math.abs(l.price - currentPrice) / currentPrice <= VISIBLE_WINDOW_PCT;
  // Tier: registry returns numeric tier 0-3. The renderer maps tier>=3=elite,
  // tier===2=strong, else normal.
  const tierName = (t) => (t >= 3 ? "elite" : t === 2 ? "strong" : "normal");
  // Top-N sort by strength desc, then assign elite/strong slots.
  const sorted = [...levels].sort((a, b) => b.strength - a.strength);
  const eliteIdx = c.eliteCount ?? 0;
  const strongIdx = c.strongCount ?? eliteIdx;
  return sorted
    .map((l, i) => {
      // Re-derive a "display tier" the way the rating engine would:
      // top eliteIdx = elite, next (strongIdx - eliteIdx) = strong, rest = normal.
      let displayTier;
      if (c.useTierEngine) {
        if (i < eliteIdx) displayTier = "elite";
        else if (i < strongIdx) displayTier = "strong";
        else displayTier = "normal";
      } else {
        displayTier = tierName(l.tier);
      }
      return { ...l, displayTier };
    })
    .filter((l) => {
      if (!inWindow(l)) return false;
      if ((l.strength ?? 0) < (c.minStrength ?? 0)) return false;
      if ((l.touches ?? 0) < (c.minTouches ?? 0)) return false;
      if (l.displayTier === "elite" && !c.showElite) return false;
      if (l.displayTier === "strong" && !c.showStrong) return false;
      if (l.displayTier === "normal" && !c.showNormal) return false;
      // useTierEngine + hideUnrated: drop everything below the strong cutoff.
      if (c.useTierEngine && c.tierEngineHideUnrated && l.displayTier === "normal") {
        return false;
      }
      return true;
    });
}

function filterStructuralZones(zones, preset, currentPrice) {
  const c = preset.values.structuralLevels;
  if (!c.enabled) return [];
  const conf = c.minConfidence;
  const confOk = (z) => {
    // The engine does not always return a discrete "confidence" string —
    // we approximate with strength + bounceRate the same way the
    // renderer would (this mirrors the "high"/"medium"/"low" gating).
    const score = (z.strength ?? 0) * 0.5 + (z.bounceRate ?? 0) * 0.5;
    if (conf === "high") return score >= 0.65;
    if (conf === "medium") return score >= 0.45;
    return true; // low → show all validated
  };
  const inWindow = (z) =>
    Math.abs((z.priceLow ?? z.price) - currentPrice) / currentPrice <= VISIBLE_WINDOW_PCT ||
    Math.abs((z.priceHigh ?? z.price) - currentPrice) / currentPrice <= VISIBLE_WINDOW_PCT;
  return zones.filter((z) => {
    if (!inWindow(z)) return false;
    if (z.method && c.methods && c.methods[z.method] === false) return false;
    if (!confOk(z)) return false;
    return true;
  });
}

function overlaps(level, zone) {
  // Treat point-zones (price only) as the same point; otherwise use
  // priceLow/priceHigh expanded by OVERLAP_TOLERANCE_PCT (matches the
  // engine's existing proximityPct constant exactly).
  const lo = (zone.priceLow ?? zone.price) * (1 - OVERLAP_TOLERANCE_PCT);
  const hi = (zone.priceHigh ?? zone.price) * (1 + OVERLAP_TOLERANCE_PCT);
  return level.price >= lo && level.price <= hi;
}

function evaluateOnce(symbol, preset) {
  const reg = JSON.parse(
    require_sync(join(FIXTURES_DIR, `registry-${symbol}.json`)),
  );
  const struct = JSON.parse(
    require_sync(join(FIXTURES_DIR, `structural-${symbol}.json`)),
  );
  const currentPrice =
    struct.currentPrice ||
    inferCurrentPrice(reg.levels) ||
    0;
  if (!currentPrice) {
    return { symbol, currentPrice: null, error: "no current price in fixtures" };
  }

  const visibleLevels = filterRegistryLevels(reg.levels ?? [], preset, currentPrice);
  const visibleZones = filterStructuralZones(struct.levels ?? [], preset, currentPrice);

  // Confluence: count zones that have at least one overlapping liquidity
  // level (after both filter sets are applied). Then if the preset is
  // confluenceOnly, drop non-overlapping zones from the visible set
  // (mirroring the renderer's behaviour).
  const overlapping = visibleZones.filter((z) =>
    visibleLevels.some((l) => overlaps(l, z)),
  );
  const finalZones = preset.values.structuralLevels.confluenceOnly
    ? overlapping
    : visibleZones;

  // Distance to nearest confluence zone (median absolute % of price).
  const overlapDistances = overlapping.map((z) => {
    const mid = (z.priceLow ?? z.price + (z.priceHigh ?? z.price)) / 2;
    return Math.abs(mid - currentPrice) / currentPrice;
  });
  const nearestConfluencePct =
    overlapDistances.length === 0 ? null : Math.min(...overlapDistances);
  const medianConfluencePct =
    overlapDistances.length === 0 ? null : median(overlapDistances);

  // Clutter score: lines per 100 px (lower = cleaner).
  const totalLines = visibleLevels.length + finalZones.length * 2;
  const clutter = (totalLines * 100) / CHART_HEIGHT_PX;

  return {
    symbol,
    currentPrice,
    liquidityVisible: visibleLevels.length,
    structuralVisible: finalZones.length,
    overlaps: overlapping.length,
    nearestConfluencePct,
    medianConfluencePct,
    totalLines,
    clutter,
  };
}

function inferCurrentPrice(levels) {
  if (!levels?.length) return 0;
  // Median price as a fallback when the structural fixture is empty.
  const sorted = [...levels].map((l) => l.price).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// node:fs is async — but we need a sync read inside evaluateOnce. Use
// node:fs sync API directly to keep evaluateOnce simple.
import { readFileSync } from "node:fs";
function require_sync(p) {
  return readFileSync(p, "utf8");
}

// ────────────────────────────────────────────────────────────
// Run + render report
const results = {};
for (const preset of PRESETS) {
  results[preset.id] = SYMBOLS.map((sym) => evaluateOnce(sym, preset));
}

function fmtPct(p) {
  return p == null ? "—" : `${(p * 100).toFixed(2)}%`;
}
function fmtNum(n) {
  if (n == null) return "—";
  if (typeof n !== "number") return String(n);
  return n.toFixed(n >= 100 ? 0 : 2);
}

const date = new Date().toISOString().slice(0, 10);
let md = "";
md += `# Preset Evaluation Snapshot\n\n`;
md += `> Generated by \`scripts/evaluatePresets.mjs\` on ${date}.\n`;
md += `> Re-run after editing \`src/lib/levelPresets.data.json\` to refresh.\n\n`;
md += `## Determinism contract\n\n`;
md += `- **Fixture symbols:** BTCUSDT, ETHUSDT, SOLUSDT (snapshots in \`__tests__/fixtures/\`)\n`;
md += `- **Timeframe:** 4h structural-zones; registry levels are timeframe-agnostic\n`;
md += `- **Visible price window:** ±${(VISIBLE_WINDOW_PCT * 100).toFixed(0)}% of current price\n`;
md += `- **Chart height assumption:** ${CHART_HEIGHT_PX} px (typical desktop)\n`;
md += `- **Overlap rule:** liquidity level price ∈ [zone.priceLow×${(1 - OVERLAP_TOLERANCE_PCT).toFixed(4)}, zone.priceHigh×${(1 + OVERLAP_TOLERANCE_PCT).toFixed(4)}] (matches engine proximityPct = ${OVERLAP_TOLERANCE_PCT * 100}%)\n`;
md += `- **Clutter score:** \`(visibleLiquidity + visibleStructural × 2) × 100 / ${CHART_HEIGHT_PX}\` (lines per 100 px; lower is cleaner)\n\n`;

md += `## Per-symbol results\n\n`;
md += `| Preset | Symbol | Liq | Struct | Overlap | Nearest conf. | Median conf. | Clutter |\n`;
md += `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
for (const preset of PRESETS) {
  for (const r of results[preset.id]) {
    md +=
      `| ${preset.label} | ${r.symbol}` +
      ` | ${fmtNum(r.liquidityVisible)}` +
      ` | ${fmtNum(r.structuralVisible)}` +
      ` | ${fmtNum(r.overlaps)}` +
      ` | ${fmtPct(r.nearestConfluencePct)}` +
      ` | ${fmtPct(r.medianConfluencePct)}` +
      ` | ${fmtNum(r.clutter)} |\n`;
  }
}

md += `\n## Aggregate (mean across BTC/ETH/SOL)\n\n`;
md += `| Preset | Liq mean | Struct mean | Overlap mean | Clutter mean | Verdict |\n`;
md += `| --- | ---: | ---: | ---: | ---: | --- |\n`;
function meanOf(arr, key) {
  const xs = arr.map((r) => r[key]).filter((v) => typeof v === "number");
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function verdict(clutter, totalLevels) {
  if (totalLevels < 2) return "⚠ too sparse — may hide opportunity";
  if (clutter > 3.0) return "⚠ too noisy — may overload the chart";
  if (clutter > 1.5) return "active — useful for intraday scanning";
  if (clutter > 0.6) return "balanced — clean and informative";
  return "minimal — high signal-to-noise";
}
for (const preset of PRESETS) {
  const arr = results[preset.id];
  const liqMean = meanOf(arr, "liquidityVisible");
  const slMean = meanOf(arr, "structuralVisible");
  const ovMean = meanOf(arr, "overlaps");
  const ctMean = meanOf(arr, "clutter");
  const totalMean = (liqMean ?? 0) + (slMean ?? 0);
  md +=
    `| ${preset.label}` +
    ` | ${fmtNum(liqMean)}` +
    ` | ${fmtNum(slMean)}` +
    ` | ${fmtNum(ovMean)}` +
    ` | ${fmtNum(ctMean)}` +
    ` | ${verdict(ctMean ?? 0, totalMean)} |\n`;
}

md += `\n## Sanity checks\n\n`;
md += `These directional checks must hold across the BTC/ETH/SOL aggregate:\n\n`;
const aggregate = (id) => meanOf(results[id], "liquidityVisible") + meanOf(results[id], "structuralVisible");
const checks = [
  ["Confluence Focused ≤ Balanced Pro", aggregate("confluence") <= aggregate("balanced") + 1],
  ["Active Intraday ≥ Balanced Pro", aggregate("active") + 1 >= aggregate("balanced")],
  ["Clean Minimal is leanest", aggregate("minimal") <= Math.min(aggregate("balanced"), aggregate("active"), aggregate("confluence")) + 1],
];
for (const [label, ok] of checks) {
  md += `- ${ok ? "✅" : "❌"} ${label}\n`;
}

md += `\n## Engine guardrail\n\n`;
md += `This evaluator is a **read-only** consumer of fixtures captured from the live backend. It does not import any engine module, does not modify scoring/confluence/decay, and does not write to the live cache. The preset module \`src/lib/levelPresets.ts\` and its data source \`src/lib/levelPresets.data.json\` are similarly display-layer only — verified by \`__tests__/levelPresets.test.mjs\` (\`guardrail: preset module imports nothing from api-server/services/engines\`).\n`;

await writeFile(REPORT_PATH, md, "utf8");
console.log(`Wrote ${REPORT_PATH}`);
console.log(`(${PRESETS.length} presets × ${SYMBOLS.length} symbols)`);
