// Regression tests for Task #106: prevent fake/synthetic data paths from
// sneaking back into the liquidity API surface.
//
// Three guard layers, all of which previously had to be enforced by code
// review:
//   1. Source-level lint guard — none of the data-path files may call
//      Math.random(...) or seededRandom(...) (the seed used by the old
//      buildSyntheticOrderbook helper). A bare grep would also flag the
//      Math.random() ID generators in liquidation websocket adapters,
//      which are NOT data fabrication, so the scope is narrowed to the
//      handful of files that previously hosted the synthetic catalog.
//   2. Filesystem guard — no `mock-data*` module is allowed under the
//      liquidity routes; that module was deleted in Task #103.
//   3. Contract guard — the generated zod enums for exchange / candle
//      source must not contain "synthetic". This catches the OpenAPI
//      spec being edited to re-introduce a synthetic exchange tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GetLiquidityHeatmapExchange,
  GetOrderbookExchange,
  GetSymbolsExchange,
  CandleDataSource,
} from "@workspace/api-zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Strip both `// line` and `/* block */` comments so we only scan the
// executable code. data.ts intentionally documents `seededRandom` in a
// header comment explaining what was removed.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const GUARDED_FILES = [
  "data.ts",
  "index.ts",
  "book-history.ts",
  "analytics-store.ts",
  "types.ts",
  "toobit.ts",
];

test("liquidity data routes do not call Math.random / seededRandom", () => {
  for (const f of GUARDED_FILES) {
    const path = join(__dirname, f);
    const src = stripComments(readFileSync(path, "utf8"));
    assert.ok(
      !/\bMath\.random\s*\(/.test(src),
      `${f}: Math.random(...) is forbidden in liquidity data routes — it was the building block of the removed synthetic orderbook generator`,
    );
    assert.ok(
      !/\bseededRandom\s*\(/.test(src),
      `${f}: seededRandom(...) is forbidden — it powered the deleted buildSyntheticOrderbook helper`,
    );
  }
});

test("no mock-data* module exists under the liquidity routes", () => {
  const entries = readdirSync(__dirname, { withFileTypes: true });
  const offenders = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /^mock[-_]?data/i.test(n));
  assert.deepEqual(
    offenders,
    [],
    `mock-data module reintroduced: ${offenders.join(", ")}`,
  );
});

test('exchange enums never contain "synthetic"', () => {
  const enums = {
    GetLiquidityHeatmapExchange,
    GetOrderbookExchange,
    GetSymbolsExchange,
    CandleDataSource,
  };
  for (const [name, e] of Object.entries(enums)) {
    const values = Object.values(e as Record<string, string>);
    assert.ok(
      !values.includes("synthetic"),
      `${name} must not contain "synthetic" (values: ${values.join(", ")}). The API now returns 503 when no live data is available instead of fabricating a "synthetic" tier.`,
    );
  }
});
