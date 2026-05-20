// apiServerRuntimeDefaultsV1
// Runtime-only defaults for Render/small hosts. These use existing env controls
// and do not modify protected engine or market-data adapter source.

const defaults = {
  HL_RATE_LIMIT_PER_SEC: '2',
  HL_RATE_LIMIT_BURST: '3',
  ENABLE_LIVE_REST_BOOT_WARM: '0',
  ENABLE_MARKET_OVERVIEW_WARM: '0',
  ENABLE_CRITICAL_BOOT_WARM: '0',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key] || String(process.env[key]).trim() === '') {
    process.env[key] = value;
  }
}

console.log('[api-server:start-safe] runtime defaults active', {
  hlRateLimitPerSec: process.env.HL_RATE_LIMIT_PER_SEC,
  hlRateLimitBurst: process.env.HL_RATE_LIMIT_BURST,
  liveRestBootWarm: process.env.ENABLE_LIVE_REST_BOOT_WARM,
  marketOverviewWarm: process.env.ENABLE_MARKET_OVERVIEW_WARM,
  criticalBootWarm: process.env.ENABLE_CRITICAL_BOOT_WARM,
});

await import('./dist/index.mjs');
