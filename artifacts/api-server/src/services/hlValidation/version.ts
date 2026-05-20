// Engine fingerprint helpers.
// VALIDATION-ONLY. Read-only — never modifies engine.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VALIDATION_SUITE_VERSION = "1.0.0";

let cachedSha: string | null = null;

export function engineGitSha(): string {
  if (cachedSha != null) return cachedSha;
  try {
    cachedSha = execSync("git rev-parse --short HEAD", {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).toString().trim() || "unknown";
  } catch {
    cachedSha = "unknown";
  }
  return cachedSha;
}

let cachedHash: string | null = null;

// Stable hash of every sealed engine source file. If a developer sneaks a
// change into the engine without bumping the SHA, this hash still moves.
export function engineConfigHash(): string {
  if (cachedHash != null) return cachedHash;
  const sealed = [
    "artifacts/api-server/src/services/engines/levels.ts",
    "artifacts/api-server/src/services/engines/confluence.ts",
    "artifacts/api-server/src/services/engines/precision.ts",
    "artifacts/api-server/src/services/engines/quantile.ts",
    "artifacts/api-server/src/services/engines/regime.ts",
    "artifacts/api-server/src/services/engines/reliability.ts",
    "artifacts/api-server/src/services/orchestrator.ts",
    "artifacts/api-server/src/services/levelsHost.ts",
    "artifacts/api-server/src/services/levelRegistry/index.ts",
    "artifacts/api-server/src/services/cache.ts",
    "artifacts/api-server/src/services/hyperliquid.ts",
  ];
  const h = createHash("sha256");
  for (const rel of sealed) {
    try {
      const buf = readFileSync(join(process.cwd(), rel));
      h.update(rel);
      h.update("\0");
      h.update(buf);
      h.update("\0");
    } catch {
      h.update(rel);
      h.update("\0MISSING\0");
    }
  }
  cachedHash = h.digest("hex").slice(0, 16);
  return cachedHash;
}
