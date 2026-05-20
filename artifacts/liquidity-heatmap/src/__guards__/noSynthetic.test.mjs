// Regression guard for Task #110 (extends Task #106): prevent synthetic /
// fabricated market data from sneaking back into the frontend. Mirrors
// `artifacts/api-server/src/routes/liquidity/noSynthetic.test.ts`.
//
// Three guard layers:
//   1. Source-level guard — files on the data path (hooks that fetch market
//      data, lib helpers that derive levels/orderflow) must not call
//      Math.random(...) or seededRandom(...). UI files that legitimately use
//      Math.random for ephemeral element ids (sidebar, watchlist row keys,
//      indicator drag handles) are intentionally excluded — those don't
//      fabricate market data.
//   2. Filesystem guard — no `mock-data*` module is allowed anywhere under
//      the frontend src tree. The synthetic catalog used to live in such a
//      module and was deleted in Task #103.
//   3. String-literal guard — the literal "synthetic" must not appear as a
//      data value (string literal) anywhere in the frontend. Comments are
//      stripped first so prose like "no synthetic noise" stays legal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// Files that touch live market data. If a Math.random() reappears here it is
// almost certainly fabricating prices/sizes/levels. Keep this list narrow and
// explicit — the UI uses Math.random() legitimately for ephemeral DOM keys.
const DATA_PATH_FILES = [
  "hooks/useChannel.ts",
  "hooks/useLiquidationClusters.ts",
  "hooks/useUpstreamPressure.ts",
  "hooks/useRegistryLevels.ts",
  "hooks/useAnalyticsOverlays.ts",
  "lib/levelScan.ts",
  "lib/levelTierAdapter.ts",
  "lib/levelTierEngine.ts",
  "lib/screenerCatalog.ts",
  "lib/structuralLevels.ts",
  "lib/watchlistApi.ts",
  "lib/chartPlugins.ts",
];

test("frontend data-path files do not call Math.random / seededRandom", () => {
  for (const rel of DATA_PATH_FILES) {
    const path = join(SRC_ROOT, rel);
    // Sanity: the file must still exist so the guard can't silently rot.
    assert.ok(
      statSync(path).isFile(),
      `${rel}: data-path file is missing — update DATA_PATH_FILES if it was renamed/removed`,
    );
    const src = stripComments(readFileSync(path, "utf8"));
    assert.ok(
      !/\bMath\.random\s*\(/.test(src),
      `${rel}: Math.random(...) is forbidden in frontend data-path code — it's the building block for fabricated market data`,
    );
    assert.ok(
      !/\bseededRandom\s*\(/.test(src),
      `${rel}: seededRandom(...) is forbidden — it powered the deleted synthetic generators`,
    );
  }
});

test("no mock-data* module exists anywhere under the frontend src tree", () => {
  const offenders = walk(SRC_ROOT)
    .map((p) => relative(SRC_ROOT, p))
    .filter((p) => /(^|[\\/])mock[-_]?data[^\\/]*$/i.test(p));
  assert.deepEqual(
    offenders,
    [],
    `mock-data module reintroduced in frontend: ${offenders.join(", ")}`,
  );
});

test('the literal "synthetic" never appears as a string value in frontend source', () => {
  const offenders = [];
  for (const path of walk(SRC_ROOT)) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) continue;
    if (path.endsWith(".test.mjs") || path.endsWith(".test.ts")) continue;
    const src = stripComments(readFileSync(path, "utf8"));
    if (/(["'`])synthetic\1/i.test(src)) {
      offenders.push(relative(SRC_ROOT, path));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `"synthetic" string literal found in frontend (data-source enums must never carry that value): ${offenders.join(", ")}`,
  );
});
