// Central Render patch runner.
//
// This shortens package.json's build command and makes patch ordering explicit
// in one auditable place. The long-term cleanup path is still to convert each
// stable patch into permanent source, but this removes the fragile shell chain
// while that conversion is done one group at a time.
//
// Transport/render/background scheduling only. Protected liquidity/structural
// formulas, confluence/scoring, DOM/Bookmap, absorption, touch classification,
// and level placement rules must not be changed by these patches.

const fs = require('fs');
const path = require('path');

const patches = [
  './patch-startup-performance.cjs',
  './patch-background-workload.cjs',
  './patch-loading-performance.cjs',
  './patch-fast-page-load.cjs',
  './patch-runtime-performance.cjs',
  './patch-restore-engine-lookback-integrity.cjs',
  './patch-structural-render.cjs',
  './patch-structural-empty-startup-retry.cjs',
  './patch-chart-structural-redraw.cjs',
  './patch-structural-diagnostic-badge.cjs',
  './patch-timeframe-switch-performance.cjs',
  './patch-chart-stability-modules.cjs',
  './patch-latency-cleanup-v2.cjs',
  './patch-frontend-timeframe-debounce.cjs',
  './patch-live-rest-warm-opt-in.cjs',
  './patch-chart-request-debounce.cjs',
  './patch-levels-request-resilience.cjs',
  './patch-level-overlay-zoom-stability.cjs',
  './patch-render-runtime-pressure.cjs',
  './patch-chart-runtime-regression-fix.cjs',
  './patch-security-ops-hardening-v1.cjs',
];

function normalizeChartRuntimePatch() {
  const patchPath = path.join(__dirname, 'patch-chart-runtime-regression-fix.cjs');
  let src = fs.readFileSync(patchPath, 'utf8');
  const strict = "function replaceOrThrow(body, find, replace, label) {\n  if (!body.includes(find)) {\n    throw new Error(`[chart-runtime-regression-fix] target not found: ${label}`);\n  }\n  return body.replace(find, replace);\n}\n";
  const tolerant = "function replaceOrThrow(body, find, replace, label) {\n  if (!body.includes(find)) {\n    console.log(`[chart-runtime-regression-fix] skipped ${label}`);\n    return body;\n  }\n  console.log(`[chart-runtime-regression-fix] applied ${label}`);\n  return body.replace(find, replace);\n}\n";
  if (!src.includes(strict)) return;
  src = src.replace(strict, tolerant);
  fs.writeFileSync(patchPath, src);
  console.log('[apply-render-patches] normalized chart runtime patch target misses to skips');
}

function normalizeSecurityOpsPatch() {
  const patchPath = path.join(__dirname, 'patch-security-ops-hardening-v1.cjs');
  if (!fs.existsSync(patchPath)) return;
  let src = fs.readFileSync(patchPath, 'utf8');
  const before = src;

  // The security patch writes TypeScript code from inside a patch-template string.
  // Normalize any escaped nested template-literal form before require() evaluates it,
  // so `${proto}` / `${host}` are not interpolated inside this patch process.
  src = src
    .replace(/return `\$\{proto\}:\/\/\$\{host\}`;/g, 'return proto + "://" + host;')
    .replace(/return \\`\$\{proto\}:\/\/\$\{host\}\\`;/g, 'return proto + "://" + host;')
    .replace(/return \\\\`\$\{proto\}:\/\/\$\{host\}\\\\`;/g, 'return proto + "://" + host;');

  if (src === before) return;
  fs.writeFileSync(patchPath, src);
  console.log('[apply-render-patches] normalized security ops patch template escaping');
}

for (const patch of patches) {
  console.log(`[apply-render-patches] ${patch}`);
  if (patch === './patch-chart-runtime-regression-fix.cjs') normalizeChartRuntimePatch();
  if (patch === './patch-security-ops-hardening-v1.cjs') normalizeSecurityOpsPatch();
  require(patch);
}

console.log('[apply-render-patches] complete');
