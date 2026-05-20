import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "../..");

function file(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function assertIncludes(source: string, markers: string[]): void {
  for (const marker of markers) {
    assert.ok(source.includes(marker), `missing marker: ${marker}`);
  }
}

test("watchlist route keeps input hardening markers", () => {
  assertIncludes(file("artifacts/api-server/src/routes/watchlists.ts"), [
    "watchlistInputHardeningV1",
    "MAX_WATCHLIST_NAME_LEN",
    "MAX_REORDER_SYMBOLS",
    "SYMBOL_RE",
    "readSymbol(req.body?.symbol)",
    "readSymbol(req.params.symbol)",
  ]);
});

test("alert route keeps input hardening markers", () => {
  assertIncludes(file("artifacts/api-server/src/routes/alerts.ts"), [
    "alertRouteInputHardeningV1",
    "MAX_PARAMS_JSON_BYTES",
    "MAX_SINKS",
    "parseWebhookUrl",
    "isDiscordWebhookUrl",
    "boundedNumber(body.throttleMs",
    "boundedNumber(req.query.limit",
  ]);
});

test("push route keeps subscription hardening markers", () => {
  assertIncludes(file("artifacts/api-server/src/routes/push.ts"), [
    "pushRouteInputHardeningV1",
    "MAX_ENDPOINT_LEN",
    "sanitizeEndpoint",
    "sanitizePushKey",
    "cleanEndpoint",
  ]);
});

test("symbol route keeps query hardening markers", () => {
  assertIncludes(file("artifacts/api-server/src/routes/symbol.ts"), [
    "symbolRouteInputHardeningV1",
    "MAX_SYMBOL_QUERY_LEN",
    "readSymbolQuery(req.query",
    "readSymbolParam(req.params.sym)",
  ]);
});

test("screener route keeps proxy input caps", () => {
  assertIncludes(file("artifacts/api-server/src/routes/screener.ts"), [
    "screenerProxyInputHardeningV1",
    "MAX_CATALOG_QUERY_BYTES",
    "MAX_CATALOG_PARAM_BYTES",
    "MAX_SCAN_BODY_BYTES",
    "readBoundedQuery(req)",
    "stringifyBoundedBody(req.body)",
  ]);
});

test("HL validation route keeps job input caps", () => {
  assertIncludes(file("artifacts/api-server/src/routes/hlValidation.ts"), [
    "hlValidationRouteInputHardeningV1",
    "RUN_ID_RE",
    "MAX_FORWARD_SYMBOLS",
    "MAX_FORWARD_INTERVALS",
    "boundedInteger(body.durationMs",
    "listOfStrings(body.symbols",
  ]);
});
