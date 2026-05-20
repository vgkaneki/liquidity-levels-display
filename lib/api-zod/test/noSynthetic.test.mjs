// Regression guard for Task #110 (extends Task #106): prevent synthetic /
// fabricated data from sneaking back into the shared workspace libraries.
// Mirrors `artifacts/api-server/src/routes/liquidity/noSynthetic.test.ts`.
//
// Scope: this test scans every `lib/*/src` source tree from a single home
// (api-zod) so the workspace only needs one extra `test` script wired into
// CI. The three guard layers:
//   1. Source-level guard — no Math.random(...) or seededRandom(...) anywhere
//      under lib/*/src. Shared libs hold the API contract, the generated
//      client, and the database schema — none of them have any business
//      generating random numbers, so a blanket ban is safe.
//   2. Filesystem guard — no `mock-data*` module is allowed anywhere under
//      lib/. That module was deleted in Task #103.
//   3. String-literal / contract guard — the literal "synthetic" must not
//      appear as a string value anywhere in lib source (this is what catches
//      the OpenAPI spec or generated zod enums being edited to re-introduce
//      a synthetic exchange / candle source tier).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../lib/api-zod/test → .../lib
const LIB_ROOT = join(__dirname, "..", "..");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo"
      ) {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// Sanity check: every lib package the guard cares about must still exist.
const LIB_PACKAGES = ["api-zod", "api-client-react", "api-spec", "db"];

test("expected lib/* packages are present (guard sanity)", () => {
  for (const pkg of LIB_PACKAGES) {
    assert.ok(
      statSync(join(LIB_ROOT, pkg)).isDirectory(),
      `lib/${pkg} is missing — update LIB_PACKAGES if it was renamed/removed`,
    );
  }
});

function libSourceFiles() {
  const files = [];
  for (const pkg of LIB_PACKAGES) {
    const pkgRoot = join(LIB_ROOT, pkg);
    // Scan src/ if present, plus top-level files like openapi.yaml, orval
    // config, drizzle config — those are part of the contract surface.
    for (const entry of readdirSync(pkgRoot, { withFileTypes: true })) {
      const full = join(pkgRoot, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "src" || entry.name === "schema") {
          for (const f of walk(full)) files.push(f);
        }
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

test("lib/* source does not call Math.random / seededRandom", () => {
  const offenders = [];
  for (const path of libSourceFiles()) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) continue;
    const src = stripComments(readFileSync(path, "utf8"));
    if (/\bMath\.random\s*\(/.test(src) || /\bseededRandom\s*\(/.test(src)) {
      offenders.push(relative(LIB_ROOT, path));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Math.random / seededRandom forbidden in shared libs (those would fabricate market data): ${offenders.join(", ")}`,
  );
});

test("no mock-data* module exists anywhere under lib/", () => {
  const offenders = [];
  for (const pkg of LIB_PACKAGES) {
    for (const path of walk(join(LIB_ROOT, pkg))) {
      const rel = relative(LIB_ROOT, path);
      if (/(^|[\\/])mock[-_]?data[^\\/]*$/i.test(rel)) {
        offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `mock-data module reintroduced under lib/: ${offenders.join(", ")}`,
  );
});

test('the literal "synthetic" never appears in lib/* source or contract files', () => {
  const offenders = [];
  for (const path of libSourceFiles()) {
    // OpenAPI spec is YAML — scan it as plain text.
    const isText = /\.(ts|tsx|js|jsx|mjs|cjs|yaml|yml|json)$/.test(path);
    if (!isText) continue;
    const raw = readFileSync(path, "utf8");
    const src = /\.(ya?ml|json)$/.test(path) ? raw : stripComments(raw);
    if (/(["'`])synthetic\1/i.test(src) || /\bsynthetic\b/i.test(src)) {
      offenders.push(relative(LIB_ROOT, path));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `"synthetic" appeared in shared libs / API contract — the API returns 503 instead of fabricating a synthetic tier: ${offenders.join(", ")}`,
  );
});
