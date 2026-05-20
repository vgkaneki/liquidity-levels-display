const fs = require('fs');

const file = 'artifacts/liquidity-heatmap/src/lib/chartSettings.tsx';
let src = fs.readFileSync(file, 'utf8');

function apply(find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[market-blue-level-colors-patch] already applied ${label}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[market-blue-level-colors-patch] skipped ${label}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[market-blue-level-colors-patch] applied ${label}`);
}

// marketBlueLevelColorsV1: use the login-page Market Strategy cyan for
// horizontal chart levels by default. Tailwind text-cyan-400 = #22d3ee.
// Display/theme only; protected engines, formulas, scoring, confluence,
// DOM, Bookmap, absorption, and touch logic are untouched.

apply(
`  | "neon"
  | "muted"`,
`  | "market-blue"
  | "neon"
  | "muted"`,
'| "market-blue"',
'add market-blue palette type',
);

apply(
`  neon: { support: "#00e5ff", resistance: "#ff2bd6" },`,
`  // marketBlueLevelColorsV1: matches the login-page Market Strategy cyan.
  "market-blue": { support: "#22d3ee", resistance: "#22d3ee" },
  neon: { support: "#00e5ff", resistance: "#ff2bd6" },`,
'"market-blue": { support: "#22d3ee", resistance: "#22d3ee" }',
'add market-blue palette colors',
);

apply(
`    colorPalette: "default",
  },
  structuralLevels: {`,
`    colorPalette: "market-blue",
  },
  structuralLevels: {`,
'liquidity market-blue default',
'default liquidity palette to market-blue',
);

apply(
`    lineStyle: "default",
    colorPalette: "default",
    lineWidthMultiplier: 1,`,
`    lineStyle: "default",
    colorPalette: "market-blue",
    lineWidthMultiplier: 1,`,
'structural market-blue default',
'default structural palette to market-blue',
);

apply(
`    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      delete parsed.structuralLevels.maxZones;
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);`,
`    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      delete parsed.structuralLevels.maxZones;
    }
    // marketBlueLevelColorsV1: migrate older saved default palettes to the
    // new Market Strategy cyan only when the user has not chosen explicit
    // support/resistance colors. Custom colors and non-default palettes stay.
    if (parsed && typeof parsed === "object" && parsed.liquidity && typeof parsed.liquidity === "object") {
      const liq = parsed.liquidity as { colorPalette?: string; supportColor?: string; resistanceColor?: string };
      if ((liq.colorPalette == null || liq.colorPalette === "default") && !liq.supportColor && !liq.resistanceColor) {
        liq.colorPalette = "market-blue";
      }
    }
    if (parsed && typeof parsed === "object" && parsed.structuralLevels && typeof parsed.structuralLevels === "object") {
      const sl = parsed.structuralLevels as { colorPalette?: string };
      if (sl.colorPalette == null || sl.colorPalette === "default") {
        sl.colorPalette = "market-blue";
      }
    }
    return deepMerge(DEFAULT_SETTINGS, parsed);`,
'marketBlueLevelColorsV1',
'migrate persisted default palettes',
);

fs.writeFileSync(file, src);
console.log('[market-blue-level-colors-patch] complete');
