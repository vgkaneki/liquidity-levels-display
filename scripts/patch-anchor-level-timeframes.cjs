const fs = require('fs');
const file = 'artifacts/api-server/src/routes/index.ts';
let src = fs.readFileSync(file, 'utf8');

function once(find, replace, marker) {
  if (src.includes(marker)) {
    console.log(`[anchor-level-timeframes] already applied ${marker}`);
    return;
  }
  if (!src.includes(find)) {
    console.log(`[anchor-level-timeframes] skipped ${marker}`);
    return;
  }
  src = src.replace(find, replace);
  console.log(`[anchor-level-timeframes] applied ${marker}`);
}

const anchorV3 = `const router: IRouter = Router();

// anchorLevelTimeframesV3: structural/liquidity levels use anchored HTF
// context, not the selected execution timeframe. Lower execution charts use
// 1H anchor levels; higher context charts use 4H anchor levels.
function anchorLevelsInterval(rawInterval: string): string {
  const normalized = normalizeInterval(rawInterval);
  const lowerExecution = new Set(["1m", "3m", "5m", "15m", "30m", "1h"]);
  return lowerExecution.has(normalized) ? "1h" : "4h";
}`;

once(
`const router: IRouter = Router();`,
anchorV3,
'anchorLevelTimeframesV3'
);

once(
`const router: IRouter = Router();

// anchorLevelTimeframesV2: structural/liquidity levels are calculated only
// from the 4H anchor context, then displayed across every lower execution
// timeframe. This prevents the selected chart interval from changing the
// actual level set.
function anchorLevelsInterval(rawInterval: string): string {
  normalizeInterval(rawInterval); // validates/normalizes caller input at the boundary
  return "4h";
}`,
anchorV3,
'anchorLevelTimeframesV3'
);

once(
`const router: IRouter = Router();

// anchorLevelTimeframesV1: structural/liquidity levels are anchored to 1H/4H
// context and displayed on lower execution timeframes. This prevents the same
// symbol from recalculating a different level set on every selected chart TF.
function anchorLevelsInterval(rawInterval: string): string {
  const normalized = normalizeInterval(rawInterval);
  const lowerExecution = new Set(["1m", "3m", "5m", "15m", "30m", "1h"]);
  return lowerExecution.has(normalized) ? "1h" : "4h";
}`,
anchorV3,
'anchorLevelTimeframesV3'
);

once(
`  if (rawInterval) {
    const normalizedInterval = normalizeInterval(rawInterval);
    url.searchParams.set("interval", normalizedInterval);
    res.locals.levelsInterval = normalizedInterval;
    mutated = true;
  }`,
`  if (rawInterval) {
    const displayInterval = normalizeInterval(rawInterval);
    const calculationInterval = anchorLevelsInterval(rawInterval);
    url.searchParams.set("interval", calculationInterval);
    res.locals.levelsDisplayInterval = displayInterval;
    res.locals.levelsInterval = calculationInterval;
    mutated = true;
  }`,
'levelsDisplayInterval = displayInterval'
);

once(
`      const isSwrCached = res.getHeader("X-Levels-SWR") === "fresh-lastgood";`,
`      const isSwrCached = res.getHeader("X-Levels-SWR") === "fresh-lastgood";
      if (body && typeof body === "object") {
        const payload = body as Record<string, unknown>;
        const displayInterval = res.locals.levelsDisplayInterval as string | undefined;
        const calculationInterval = res.locals.levelsInterval as string | undefined;
        if (displayInterval && calculationInterval) {
          payload.displayInterval = displayInterval;
          payload.anchorInterval = calculationInterval;
          payload.calculationInterval = calculationInterval;
          payload.interval = displayInterval;
        }
      }`,
'payload.anchorInterval = calculationInterval'
);

fs.writeFileSync(file, src);
console.log('[anchor-level-timeframes] complete');
