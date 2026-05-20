const fs = require('fs');
const crypto = require('crypto');

const override = process.env.ENGINE_PROTECTION_OVERRIDE === 'TYLER_CONFIRMED_ENGINE_CHANGE';

const protectedFiles = [
  {
    path: 'artifacts/api-server/src/services/engines/levels.ts',
    sha: '843634a6364a8c05c8eeda426bbc465b60ab2f99',
    reason: 'level placement, pivots, KDE/profile, validation, bounce/touch logic',
  },
  {
    path: 'artifacts/api-server/src/services/engines/confluence.ts',
    sha: 'c3f9a5d2cd771d1b4bcaf51f11681d1ff334d6b7',
    reason: 'confluence merging and scoring',
  },
  {
    path: 'artifacts/api-server/src/services/engines/precision.ts',
    sha: '6dac6df241c019dc55abe7e3b2be66bd043faa8d',
    reason: 'precise entry methods and execution-price selection',
  },
  {
    path: 'artifacts/api-server/src/services/engines/reliability.ts',
    sha: 'dfb602db3be6f23bbfcaa4415035825a3d4d18a1',
    reason: 'reliability and statistical confidence math',
  },
  {
    path: 'artifacts/api-server/src/services/engines/regime.ts',
    sha: '5cc2d122913085b9949c4eea07ff6fe24395c217',
    reason: 'market regime and volatility math',
  },
  {
    path: 'artifacts/api-server/src/services/engines/orderflow.ts',
    sha: 'a027892469f8a421215992e18cba171f3fef50a4',
    reason: 'order-flow metrics used around levels',
  },
  {
    path: 'artifacts/api-server/src/services/orchestrator.ts',
    sha: 'b3bbee1211ec3adf16a28ae7f89d368bea5fd683',
    reason: 'structural/liquidity orchestration, lookback, source assembly, response shape',
  },
  {
    path: 'artifacts/api-server/src/services/levelsHost.ts',
    sha: 'bd578577083fb056eb0ca3f3433743e5716e7d67',
    reason: 'engine boundary normalization and registry ingestion',
  },
  {
    path: 'artifacts/api-server/src/services/cache.ts',
    sha: '39ca1be48527d0d220222096c0e957e8390a1df5',
    reason: 'engine cache behavior and freshness semantics',
  },
  {
    path: 'artifacts/api-server/src/services/hyperliquid.ts',
    sha: '2a1c6e40b8bf4f4f2250c93f89184e97565efac5',
    reason: 'engine market-data adapter and request/lookback boundaries',
  },
];

const forbiddenBuildScripts = [
  'patch-level-engine-bugfixes.cjs',
  'patch-level-engine-bugfixes-v2.cjs',
  'patch-anchor-level-timeframes.cjs',
];

function gitBlobSha(content) {
  const prefix = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(prefix).update(content).digest('hex');
}

const failures = [];
for (const item of protectedFiles) {
  if (!fs.existsSync(item.path)) {
    failures.push(`${item.path}: missing protected file (${item.reason})`);
    continue;
  }
  const content = fs.readFileSync(item.path);
  const actual = gitBlobSha(content);
  if (actual !== item.sha) {
    failures.push(`${item.path}: protected engine changed\n  expected ${item.sha}\n  actual   ${actual}\n  reason   ${item.reason}`);
  }
}

if (fs.existsSync('package.json')) {
  const pkg = fs.readFileSync('package.json', 'utf8');
  for (const forbidden of forbiddenBuildScripts) {
    if (pkg.includes(forbidden)) {
      failures.push(`package.json build script includes forbidden engine-changing patch: ${forbidden}`);
    }
  }
}

if (failures.length > 0 && !override) {
  console.error('\n[engine-guard] BLOCKED: protected original engine files changed.');
  console.error('[engine-guard] These engines are locked until Tyler explicitly confirms an engine change.');
  console.error('[engine-guard] Fix: revert the engine change, or only proceed after explicit confirmation and update this guard baseline.\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (failures.length > 0 && override) {
  console.warn('\n[engine-guard] OVERRIDE ACTIVE: protected engine changes detected but allowed by ENGINE_PROTECTION_OVERRIDE.');
  for (const failure of failures) console.warn(`- ${failure}`);
} else {
  console.log(`[engine-guard] OK: ${protectedFiles.length} protected original engine files unchanged.`);
}
