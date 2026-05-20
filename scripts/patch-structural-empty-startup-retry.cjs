const fs = require('fs');
const file = 'artifacts/liquidity-heatmap/src/lib/structuralLevels.ts';
let src = fs.readFileSync(file, 'utf8');

if (!src.includes('emptyStartupRetryV1')) {
  const find = `    if (headerStale && json.stale !== true) json.stale = true;
    entry.latest = json;`;

  const replacement = `    if (Array.isArray(json.zones) && json.zones.length === 0 && json.unsupported !== true) {
      // emptyStartupRetryV1: an empty zone array during cold start / rate pressure
      // is not useful for the active chart. Do not accept it as the first visible
      // structural state; retry quickly until the real structural compute arrives.
      scheduledSoon = true;
      scheduleSoon(entry, 5_000);
      return;
    }

    if (headerStale && json.stale !== true) json.stale = true;
    entry.latest = json;`;

  if (!src.includes(find)) {
    console.log('[structural-empty-startup-retry-patch] skipped target not found');
  } else {
    src = src.replace(find, replacement);
    fs.writeFileSync(file, src);
    console.log('[structural-empty-startup-retry-patch] applied emptyStartupRetryV1');
  }
} else {
  console.log('[structural-empty-startup-retry-patch] already applied');
}
