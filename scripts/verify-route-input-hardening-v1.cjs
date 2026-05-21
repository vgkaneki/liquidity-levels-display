const fs = require('fs');

const verbose = process.env.ROUTE_INPUT_VERIFY_VERBOSE === '1' || process.env.CI_VERBOSE === '1';
const checks = [];
function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (ok && !verbose) return;
  const line = `[route-input-verify] ${ok ? 'OK' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`;
  if (ok) console.log(line);
  else console.error(line);
}
function contains(file, marker, name) {
  check(name, read(file).includes(marker), `${file} :: ${marker}`);
}

// routeInputHardeningVerifierV1: verifies API-boundary validation markers only.
contains('artifacts/api-server/src/routes/watchlists.ts', 'watchlistInputHardeningV1', 'watchlist input hardening marker present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'MAX_WATCHLIST_NAME_LEN', 'watchlist name cap present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'MAX_REORDER_SYMBOLS', 'watchlist reorder cap present');
contains('artifacts/api-server/src/routes/watchlists.ts', 'SYMBOL_RE', 'watchlist symbol validation present');

contains('artifacts/api-server/src/routes/alerts.ts', 'alertRouteInputHardeningV1', 'alert route hardening marker present');
contains('artifacts/api-server/src/routes/alerts.ts', 'MAX_PARAMS_JSON_BYTES', 'alert params size cap present');
contains('artifacts/api-server/src/routes/alerts.ts', 'parseWebhookUrl', 'alert URL validator present');
contains('artifacts/api-server/src/routes/alerts.ts', 'isDiscordWebhookUrl', 'alert Discord validator present');
contains('artifacts/api-server/src/routes/alerts.ts', 'boundedNumber(body.throttleMs', 'alert throttle clamp wired');
contains('artifacts/api-server/src/routes/alerts.ts', 'boundedNumber(req.query.limit', 'alert history limit clamp wired');

contains('artifacts/api-server/src/routes/push.ts', 'pushRouteInputHardeningV1', 'push route hardening marker present');
contains('artifacts/api-server/src/routes/push.ts', 'sanitizeEndpoint', 'push endpoint sanitizer present');
contains('artifacts/api-server/src/routes/push.ts', 'sanitizePushKey', 'push key sanitizer present');
contains('artifacts/api-server/src/routes/push.ts', 'cleanEndpoint', 'push sanitized endpoint wiring present');

contains('artifacts/api-server/src/routes/symbol.ts', 'symbolRouteInputHardeningV1', 'symbol route hardening marker present');
contains('artifacts/api-server/src/routes/symbol.ts', 'MAX_SYMBOL_QUERY_LEN', 'symbol query length cap present');
contains('artifacts/api-server/src/routes/symbol.ts', 'readSymbolQuery(req.query', 'symbol search query validation wired');
contains('artifacts/api-server/src/routes/symbol.ts', 'readSymbolParam(req.params.sym)', 'symbol debug param validation wired');

contains('artifacts/api-server/src/routes/screener.ts', 'screenerProxyInputHardeningV1', 'screener proxy hardening marker present');
contains('artifacts/api-server/src/routes/screener.ts', 'MAX_CATALOG_QUERY_BYTES', 'screener catalog cap present');
contains('artifacts/api-server/src/routes/screener.ts', 'MAX_SCAN_BODY_BYTES', 'screener scan cap present');

contains('artifacts/api-server/src/routes/hlValidation.ts', 'hlValidationRouteInputHardeningV1', 'HL validation route hardening marker present');
contains('artifacts/api-server/src/routes/hlValidation.ts', 'RUN_ID_RE', 'HL validation run id cap present');
contains('artifacts/api-server/src/routes/hlValidation.ts', 'MAX_FORWARD_SYMBOLS', 'HL validation forward symbol cap present');
contains('artifacts/api-server/src/routes/hlValidation.ts', 'boundedInteger(body.durationMs', 'HL validation forward duration clamp wired');
contains('artifacts/api-server/src/routes/hlValidation.ts', 'listOfStrings(body.symbols', 'HL validation forward symbol sanitizer wired');

const failed = checks.filter((c) => !c.ok);
const summary = {
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  failedCount: failed.length,
  totalChecks: checks.length,
  checks,
};
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/route-input-verification.json', JSON.stringify(summary, null, 2));
fs.writeFileSync(
  'reports/route-input-verification.md',
  [
    '# Route Input Hardening Verification',
    '',
    `Status: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `Checked at: ${summary.checkedAt}`,
    `Checks: ${summary.totalChecks}`,
    `Failures: ${summary.failedCount}`,
    '',
    '## Results',
    ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    '',
  ].join('\n'),
);
if (failed.length > 0) {
  console.error(`[route-input-verify] failed ${failed.length}/${checks.length} checks`);
  process.exit(1);
}
console.log(`[route-input-verify] PASS: ${checks.length} checks passed`);
