// noSynthetic — guard that the validation harness never silently
// fabricates candle data. The hardening pass guarantees Hyperliquid is
// the only data source: NO Math.random based candle factory, NO
// hardcoded synthetic OHLC inside the dataFetcher / engineAdapter /
// walkForward / evaluator / report files.
//
// Tests in this folder DO use Math.random-style synthetic bars by
// design (to keep tests hermetic) — those are excluded by file path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listSourceFiles(p, out);
    else if (st.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("noSynthetic: no `Math.random` in production hlValidation source files", () => {
  const files = listSourceFiles(ROOT);
  assert.ok(files.length >= 8, `expected several hlValidation files, found ${files.length}`);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Strip line comments + block comments + string literals before scanning so
    // documentation references (e.g. "no Math.random") don't trip the test.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/`[^`]*`/g, "")
      .replace(/"[^"\n]*"/g, "")
      .replace(/'[^'\n]*'/g, "");
    if (/\bMath\.random\b/.test(stripped)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `unexpected Math.random in: ${offenders.join(", ")}`);
});

test("noSynthetic: dataFetcher imports from hyperliquid only, never okx/toobit/binance", () => {
  const fetcher = readFileSync(join(ROOT, "dataFetcher.ts"), "utf8");
  const stripped = fetcher
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // ESM import statements only — comments / docstrings are fine.
  const importLines = stripped.split("\n").filter((l) => /^\s*import\s/.test(l));
  for (const l of importLines) {
    assert.ok(!/['"](.*\/)?okx['"]/i.test(l), `dataFetcher imports OKX: ${l}`);
    assert.ok(!/['"](.*\/)?toobit['"]/i.test(l), `dataFetcher imports Toobit: ${l}`);
    assert.ok(!/['"](.*\/)?binance['"]/i.test(l), `dataFetcher imports Binance: ${l}`);
  }
  // Must reference the hyperliquid client.
  assert.ok(/hyperliquid/i.test(stripped),
    "dataFetcher must reference the hyperliquid client");
});
