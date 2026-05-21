const { execFileSync } = require('child_process');
const verbose = process.env.PATCH_RUNNER_VERBOSE === '1' || process.env.CI_VERBOSE === '1';
function log(message) {
  if (verbose) console.log(message);
}

// restoreEngineSemanticsOnlyV3:
// This script intentionally performs NO mutations to protected engine files.
// The original engines are now locked by scripts/guard-protected-engines.cjs.
// Any build-time patch that edits levels.ts, orchestrator.ts, confluence.ts,
// precision.ts, reliability.ts, regime.ts, orderflow.ts, levelsHost.ts,
// cache.ts, or hyperliquid.ts must be blocked unless Tyler explicitly confirms
// an engine change and the guard baseline is updated afterward.
//
// Important: older versions of this script tried to "restore" orchestrator.ts
// by replacing chronological pivot weighting with an older path. That changed
// the protected baseline and correctly failed Render verification. Keeping this
// script as a guard-only compatibility shim lets the existing build:render chain
// stay stable while guaranteeing no protected formulas, scoring, confluence,
// touch rules, or orchestration semantics are modified during build.

try {
  execFileSync(process.execPath, ['scripts/guard-protected-engines.cjs'], { stdio: verbose ? 'inherit' : 'pipe' });
  log('[restore-engine-lookback] protected engine baseline verified; no mutations applied');
} catch (err) {
  console.error('[restore-engine-lookback] protected engine baseline verification failed');
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

log('[restore-engine-lookback] complete');
