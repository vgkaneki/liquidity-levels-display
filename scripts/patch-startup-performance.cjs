const fs = require('fs');
const file = 'artifacts/api-server/src/index.ts';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker) {
  if (src.includes(marker)) {
    console.log(`[startup-performance-patch] already applied ${marker}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[startup-performance-patch] skipped ${marker}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[startup-performance-patch] applied ${marker}`);
}

apply(
`const HL_BAR_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
  "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
};`,
`const HL_BAR_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
  "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
};

// startupPerformanceV2: boot warmups are opt-in. A broad static warm list can
// create Hyperliquid/OKX/Toobit pressure during Render cold starts and compete
// with the user's foreground chart. Default is zero boot warm jobs. Operators
// can enable a tiny critical set or explicit pairs when needed. Infrastructure
// scheduling only; protected level formulas, scoring, confluence, DOM, Bookmap,
// absorption, touch classification, and level placement rules are untouched.
const ENABLE_FULL_BOOT_WARM = process.env["ENABLE_FULL_BOOT_WARM"] === "1";
const ENABLE_CRITICAL_BOOT_WARM = process.env["ENABLE_CRITICAL_BOOT_WARM"] === "1";
const BOOT_WARM_STEP_MS = Math.max(
  2_500,
  Number(process.env["BOOT_WARM_STEP_MS"] ?? "8000") || 8_000,
);
const BOOT_WARM_CANDLE_BARS = Math.min(
  1_500,
  Math.max(300, Number(process.env["BOOT_WARM_CANDLE_BARS"] ?? "700") || 700),
);
const CRITICAL_BOOT_WARM = new Set([
  "BTCUSDT|1m", "BTCUSDT|5m", "BTCUSDT|15m",
  "ETHUSDT|1m", "ETHUSDT|5m", "ETHUSDT|15m",
  "SOLUSDT|1m", "SOLUSDT|5m", "SOLUSDT|15m",
]);
function parseBootWarmPairs(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const pairs: Array<[string, string]> = [];
  for (const token of raw.split(/[;,]/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [symRaw, tfRaw] = trimmed.split(/[|:]/);
    const sym = (symRaw ?? "").trim().replace(/[-_]/g, "").toUpperCase();
    const tf = (tfRaw ?? "").trim();
    if (!sym || !tf) continue;
    pairs.push([sym, tf]);
  }
  return pairs;
}
const EXPLICIT_BOOT_WARM = parseBootWarmPairs(process.env["BOOT_WARM_PAIRS"]);`,
'startupPerformanceV2'
);

apply(
  "  const orderedWarm = [...WARM].sort((a, b) => {",
  [
    "  const bootWarmSource = ENABLE_FULL_BOOT_WARM",
    "    ? WARM",
    "    : EXPLICIT_BOOT_WARM.length > 0",
    "      ? EXPLICIT_BOOT_WARM",
    "      : ENABLE_CRITICAL_BOOT_WARM",
    "        ? WARM.filter(([sym, tf]) => CRITICAL_BOOT_WARM.has(`${sym}|${tf}`))",
    "        : [];",
    "  logger.info({",
    "    mode: ENABLE_FULL_BOOT_WARM ? \"full\" : EXPLICIT_BOOT_WARM.length > 0 ? \"explicit\" : ENABLE_CRITICAL_BOOT_WARM ? \"critical\" : \"off\",",
    "    count: bootWarmSource.length,",
    "    stepMs: BOOT_WARM_STEP_MS,",
    "    candleBars: BOOT_WARM_CANDLE_BARS,",
    "  }, \"startup warm: configured\");",
    "  const orderedWarm = [...bootWarmSource].sort((a, b) => {",
  ].join("\n"),
  'startup warm: configured'
);

apply(
`        const WARM_BARS = 5_000;`,
`        const WARM_BARS = BOOT_WARM_CANDLE_BARS;`,
'const WARM_BARS = BOOT_WARM_CANDLE_BARS;'
);

apply(
`    }, idx * 1500).unref();`,
`    }, idx * BOOT_WARM_STEP_MS).unref();`,
'idx * BOOT_WARM_STEP_MS'
);

fs.writeFileSync(file, src);
console.log('[startup-performance-patch] complete');
