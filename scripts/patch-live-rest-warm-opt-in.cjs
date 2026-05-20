const fs = require('fs');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, src) { fs.writeFileSync(file, src); }
function apply(src, find, replace, marker, label) {
  if (src.includes(marker)) {
    console.log(`[live-rest-warm-opt-in-patch] already applied ${label}`);
    return src;
  }
  if (!src.includes(find)) {
    console.log(`[live-rest-warm-opt-in-patch] skipped ${label}`);
    return src;
  }
  console.log(`[live-rest-warm-opt-in-patch] applied ${label}`);
  return src.replace(find, replace);
}

// Boot traffic cleanup only.
// The startup live market data path already opens WS subscriptions for the
// pinned symbols. Do not also issue eager REST book/ticker/funding/OI/asset
// bootstraps for every symbol on a free Render instance; that boot wave was
// enough to trigger HL 429s before the first user interaction. Operators can
// re-enable the old eager REST warm with ENABLE_LIVE_BOOT_REST_WARM=1.
// Protected liquidity/structural formulas, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, and level placement rules are untouched.
{
  const file = 'artifacts/api-server/src/routes/liquidity/exchanges/live.ts';
  let src = read(file);
  src = apply(
    src,
`const UNIVERSE_TTL_MS = 60 * 60_000;
`,
`const UNIVERSE_TTL_MS = 60 * 60_000;
const ENABLE_LIVE_BOOT_REST_WARM = process.env.ENABLE_LIVE_BOOT_REST_WARM === "1"; // liveRestWarmOptInV1
`,
    'liveRestWarmOptInV1',
    'live REST boot warm opt-in constant',
  );
  src = apply(
    src,
`    void ensureOkxField(s, "book").catch(() => {});
    void ensureOkxField(s, "ticker").catch(() => {});
    void ensureOkxField(s, "funding").catch(() => {});
    void ensureOkxField(s, "oi").catch(() => {});
    void ensureHlField(s, "book").catch(() => {});
    void ensureHlField(s, "asset").catch(() => {});
`,
`    if (ENABLE_LIVE_BOOT_REST_WARM) {
      void ensureOkxField(s, "book").catch(() => {});
      void ensureOkxField(s, "ticker").catch(() => {});
      void ensureOkxField(s, "funding").catch(() => {});
      void ensureOkxField(s, "oi").catch(() => {});
      void ensureHlField(s, "book").catch(() => {});
      void ensureHlField(s, "asset").catch(() => {});
    }
`,
    'if (ENABLE_LIVE_BOOT_REST_WARM)',
    'guard eager live REST boot warm',
  );
  write(file, src);
}

console.log('[live-rest-warm-opt-in-patch] complete');
