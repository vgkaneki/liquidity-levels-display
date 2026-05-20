// Live-state mutation guard.
// VALIDATION-ONLY. Reads only public registry surface and DB read-only
// SELECT counts; never writes to anything.
//
// PASSED criteria (tightened for hardening pass):
//   - registry stats unchanged AND
//   - per-symbol registry digests unchanged AND
//   - DB row counts unchanged for every introspectable table AND
//   - no introspection failures
//
// Anything weaker → PARTIAL with explicit notes. Never silently
// promote PARTIAL → PASSED.

import { createHash } from "node:crypto";
import { levelRegistry } from "../levelRegistry";
import { logger } from "../../lib/logger";
import type { MutationSnapshot } from "./types";

type DbCounts = Record<string, number>;

// Dynamic, typed-loose import of @workspace/db. We do this via dynamic
// import because the @workspace/db barrel currently has unrelated
// pre-existing type-export issues that would otherwise spurious-fail
// `tsc --noEmit` on this file. At runtime the barrel works fine
// (esbuild bundles it), so the harness gets real DB snapshots; if for
// any reason the import fails (e.g. DATABASE_URL missing at boot, db
// pool not initialised) we degrade gracefully into PARTIAL.
async function snapshotDbCounts(): Promise<{ counts: DbCounts; failures: string[] }> {
  const counts: DbCounts = {};
  const failures: string[] = [];
  try {
    const dbMod = (await import("@workspace/db")) as unknown as {
      db: { execute: (q: unknown) => Promise<{ rows?: Array<Record<string, unknown>>; [k: string]: unknown }> };
      sql?: unknown;
    };
    // Use raw SQL via execute() so we don't depend on the schema-typed
    // `select(...).from(table)` API (which fails the pre-existing
    // type check). The literal table names are the canonical ones from
    // lib/db/src/schema/{liquidityLevels,liquidationEvents,users,extensions}.ts.
    const tableNames = ["liquidity_levels", "liquidation_events", "users", "user_preferences"];
    // Pull `sql` from drizzle-orm directly to construct safe template
    // literals (drizzle-orm is a peer of @workspace/db so it's loaded).
    const sqlMod = (await import("drizzle-orm")) as unknown as {
      sql: ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & { raw: (s: string) => unknown };
    };
    const sql = sqlMod.sql;
    for (const t of tableNames) {
      try {
        // Table names come from a fixed allowlist above — no user input.
        const q = sql`select count(*)::int as c from ${sql.raw(t)}`;
        const result = await dbMod.db.execute(q);
        const rows = (result as { rows?: Array<{ c: number }> }).rows ?? (result as unknown as Array<{ c: number }>);
        const c = Array.isArray(rows) && rows[0] && typeof rows[0].c === "number" ? rows[0].c : 0;
        counts[t] = c;
      } catch (e) {
        failures.push(`${t} count: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    failures.push(`db module load: ${(e as Error).message}`);
  }
  return { counts, failures };
}

export async function snapshotLiveRegistry(symbols: string[]): Promise<MutationSnapshot> {
  const stats = levelRegistry.stats();
  const digests: Record<string, string> = {};
  const notes: string[] = [];
  let partial = false;

  for (const sym of symbols) {
    const perp = sym.endsWith("USDT") ? sym : `${sym}USDT`;
    try {
      const rows = levelRegistry.rawForSymbol(perp);
      const h = createHash("sha256");
      for (const r of rows.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        h.update(`${r.id}|${r.price}|${r.strength}|${r.touches}|${r.lastConfirmedAt}\n`);
      }
      digests[perp] = h.digest("hex").slice(0, 16);
    } catch (e) {
      partial = true;
      notes.push(`rawForSymbol(${perp}) threw: ${(e as Error).message}`);
    }
  }

  // DB count snapshot — additive read-only SELECT count(*) on every
  // introspectable persisted table. Failure to read ANY of them
  // downgrades the verdict to PARTIAL.
  const { counts: dbCounts, failures: dbFailures } = await snapshotDbCounts();
  if (dbFailures.length > 0) {
    partial = true;
    for (const f of dbFailures) notes.push(`db snapshot failure → ${f}`);
  }

  // The TtlCache instances live inside the SEALED `services/orchestrator`
  // module. They are not exported, and per the spec we cannot modify
  // orchestrator.ts to re-export them. We therefore document this gap
  // as PARTIAL — the new `TtlCache.snapshot()` getter is in place
  // (see services/cache.ts) so a future opt-in registration system
  // could close the gap without breaking the seal.
  partial = true;
  notes.push("TtlCache key inventory cannot be reached from outside the sealed orchestrator without modifying it; cache-mutation check is PARTIAL. (TtlCache.snapshot() getter added in services/cache.ts as a future-proof additive read-only hook.)");
  notes.push("Alerts / paper-PnL DB tables are not yet defined in the schema (see lib/db/src/schema/index.ts: only users, liquidity_levels, liquidation_events, extensions exist). The relevant tables are introspected; remaining ones are PARTIAL by absence.");

  logger.info({ stats, dbCounts }, "hl-validation: registry+db snapshot taken");
  return {
    takenAt: Date.now(),
    registryStats: stats,
    registryDigests: digests,
    dbCounts,
    partial,
    notes,
  };
}

export interface MutationVerdict {
  passed: boolean;
  partial: boolean;
  diff: {
    statsChanged: boolean;
    digestChanges: Array<{ symbol: string; before: string | undefined; after: string | undefined }>;
    dbChanges: Array<{ table: string; before: number | undefined; after: number | undefined }>;
  };
  notes: string[];
}

export function compareSnapshots(before: MutationSnapshot, after: MutationSnapshot): MutationVerdict {
  const statsChanged = before.registryStats.symbols !== after.registryStats.symbols
    || before.registryStats.total !== after.registryStats.total;
  const digestChanges: MutationVerdict["diff"]["digestChanges"] = [];
  const allKeys = new Set([...Object.keys(before.registryDigests), ...Object.keys(after.registryDigests)]);
  for (const k of allKeys) {
    const b = before.registryDigests[k];
    const a = after.registryDigests[k];
    if (b !== a) digestChanges.push({ symbol: k, before: b, after: a });
  }
  const dbChanges: MutationVerdict["diff"]["dbChanges"] = [];
  const tableKeys = new Set([
    ...Object.keys(before.dbCounts ?? {}),
    ...Object.keys(after.dbCounts ?? {}),
  ]);
  for (const t of tableKeys) {
    const b = (before.dbCounts ?? {})[t as keyof typeof before.dbCounts];
    const a = (after.dbCounts ?? {})[t as keyof typeof after.dbCounts];
    if (b !== a) dbChanges.push({ table: t, before: b, after: a });
  }
  // PASSED iff ALL of the following hold:
  //  - registry totals unchanged
  //  - every per-symbol digest unchanged
  //  - every DB count unchanged
  //  - neither snapshot reported PARTIAL
  // Otherwise the verdict is "delta observed" or PARTIAL.
  const observedClean = !statsChanged && digestChanges.length === 0 && dbChanges.length === 0;
  const passed = observedClean && !before.partial && !after.partial;
  return {
    passed,
    partial: before.partial || after.partial,
    diff: { statsChanged, digestChanges, dbChanges },
    notes: [
      ...before.notes,
      ...after.notes,
      observedClean
        ? "All introspected surfaces unchanged across the validation window."
        : "Background engine warmups may legitimately mutate the registry/DB concurrently with validation; an observed delta does not by itself prove the validation harness wrote anything.",
    ],
  };
}
