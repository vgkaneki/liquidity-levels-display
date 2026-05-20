const fs = require('fs');

const symbolRegistryFile = 'artifacts/api-server/src/services/symbolRegistry/index.ts';
const indexFile = 'artifacts/api-server/src/index.ts';

function patchFile(file, fn) {
  let src = fs.readFileSync(file, 'utf8');
  const next = fn(src);
  if (next !== src) fs.writeFileSync(file, next);
}

function replace(src, find, repl, marker, label) {
  if (src.includes(marker)) {
    console.log(`[render-runtime-pressure-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[render-runtime-pressure-patch] skipped ${label}`);
    return src;
  }
  console.log(`[render-runtime-pressure-patch] applied ${label}`);
  return src.replace(find, repl);
}

// renderRuntimePressureV1:
// Reduce startup/runtime pressure seen in Render logs: repeated Toobit registry
// failures and early Hyperliquid 429s. This is infrastructure scheduling and
// symbol-registry behavior only. Protected engines, formulas, scoring,
// confluence, DOM, Bookmap, absorption, and touch logic are untouched.

patchFile(symbolRegistryFile, (src) => {
  src = replace(
    src,
    'const ADAPTERS: SymbolAdapter[] = [hlAdapter, okxAdapter, toobitAdapter];',
    [
      '// renderRuntimePressureV1: Toobit registry refresh is optional on Render.',
      '// In production logs it repeatedly returned null and added noisy retries while',
      '// HL/OKX already supplied the active chart universe. Opt in with',
      '// ENABLE_TOOBIT_SYMBOL_REGISTRY=1 when Toobit is healthy/needed. Routing still',
      '// remains safe: disabled/missing snapshots resolve as unknown, not false 404s.',
      'const ENABLE_TOOBIT_SYMBOL_REGISTRY = process.env["ENABLE_TOOBIT_SYMBOL_REGISTRY"] === "1";',
      'const ADAPTERS: SymbolAdapter[] = ENABLE_TOOBIT_SYMBOL_REGISTRY',
      '  ? [hlAdapter, okxAdapter, toobitAdapter]',
      '  : [hlAdapter, okxAdapter];',
      'const ACTIVE_EXCHANGES = new Set<ExchangeId>(ADAPTERS.map((a) => a.exchange));',
    ].join('\n'),
    'renderRuntimePressureV1',
    'optional Toobit registry adapter',
  );

  src = replace(
    src,
    '  for (const ex of ALL_EXCHANGES) {\n    const s = snapshots[ex];\n    if (!s || !s.ok) return false;\n    if (now - s.fetchedAt >= GLOBAL_STALE_MS) return false;\n  }',
    '  for (const ex of ACTIVE_EXCHANGES) {\n    const s = snapshots[ex];\n    if (!s || !s.ok) return false;\n    if (now - s.fetchedAt >= GLOBAL_STALE_MS) return false;\n  }',
    'for (const ex of ACTIVE_EXCHANGES)',
    'active-exchange freshness gate',
  );

  src = replace(
    src,
    '        ALL_EXCHANGES.map((ex) => [ex, !!snapshots[ex]?.ok]),',
    '        ALL_EXCHANGES.map((ex) => [\n          ex,\n          ACTIVE_EXCHANGES.has(ex) ? !!snapshots[ex]?.ok : "disabled",\n        ]),',
    'ACTIVE_EXCHANGES.has(ex) ? !!snapshots[ex]?.ok : "disabled"',
    'log disabled adapters explicitly',
  );

  return src;
});

patchFile(indexFile, (src) => {
  src = replace(
    src,
    'const ENABLE_BOOT_WARM = process.env["ENABLE_BOOT_WARM"] !== "0";',
    'const ENABLE_BOOT_WARM = process.env["ENABLE_BOOT_WARM"] === "1";',
    'const ENABLE_BOOT_WARM = process.env["ENABLE_BOOT_WARM"] === "1";',
    'make boot warm opt-in',
  );

  src = replace(
    src,
    'Number(process.env["BOOT_WARM_STEP_MS"] ?? "5000") || 5_000,',
    'Number(process.env["BOOT_WARM_STEP_MS"] ?? "8000") || 8_000,',
    'Number(process.env["BOOT_WARM_STEP_MS"] ?? "8000")',
    'slower boot warm cadence',
  );

  src = replace(
    src,
    'Math.max(500, Number(process.env["BOOT_WARM_CANDLE_BARS"] ?? "1200") || 1_200),',
    'Math.max(400, Number(process.env["BOOT_WARM_CANDLE_BARS"] ?? "700") || 700),',
    'Number(process.env["BOOT_WARM_CANDLE_BARS"] ?? "700")',
    'lower boot warm candle pressure',
  );

  return src;
});

console.log('[render-runtime-pressure-patch] complete');
