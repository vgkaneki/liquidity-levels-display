// Postgres persistence for the in-memory level registry.
//   - At boot: SELECT every row and hand it to `levelRegistry.loadSnapshot`.
//   - At runtime: every PERSIST_INTERVAL_MS, drain dirty symbols and
//     UPSERT their rows in a single transaction. Symbols whose rows have
//     all been evicted in-memory get a DELETE for the gap.
//
// We never block the hot path on database I/O — `recordZones` just marks
// the symbol dirty and the persistence loop catches up.

import { sql } from "drizzle-orm";
import { db, liquidityLevelsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { levelRegistry, type RegistryLevel } from "./index";

const PERSIST_INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
// In-flight guard: prevents two persistence runs from clobbering each
// other. The interval may fire while a previous DB round-trip is still
// flushing 100s of symbols; without this, a slower run could DELETE rows
// that a faster concurrent run had just upserted.
let inflight = false;

function rowFromMem(lev: RegistryLevel) {
  return {
    id: lev.id,
    symbol: lev.symbol,
    side: lev.side,
    tier: lev.tier,
    price: lev.price,
    strength: lev.strength,
    reliability: lev.reliability,
    firstSeenAt: lev.firstSeenAt,
    lastConfirmedAt: lev.lastConfirmedAt,
    touches: lev.touches,
    methodsJson: JSON.stringify(lev.methods),
  };
}

export async function loadRegistryFromDb(): Promise<void> {
  // Fail-fast: the boot sequence guarantees the in-memory registry is
  // populated BEFORE the HTTP server starts listening, so an empty
  // registry would silently re-introduce the warmup gap this layer is
  // supposed to eliminate. Surface the error instead of swallowing it.
  const rows = await db.select().from(liquidityLevelsTable);
  const mem: RegistryLevel[] = rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side as RegistryLevel["side"],
    tier: r.tier,
    price: r.price,
    strength: r.strength,
    reliability: r.reliability,
    firstSeenAt: Number(r.firstSeenAt),
    lastConfirmedAt: Number(r.lastConfirmedAt),
    touches: r.touches,
    methods: safeParseMethods(r.methodsJson),
  }));
  levelRegistry.loadSnapshot(mem);
  logger.info({ count: mem.length }, "level-registry: snapshot loaded");
}

function safeParseMethods(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

async function persistDirty(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const dirty = levelRegistry.drainDirty();
    if (dirty.length === 0) return;
    for (const symbol of dirty) {
      // Snapshot once: rawForSymbol is read-only into the shared map but
      // we want delete + upsert to operate on the same view of the
      // registry. Mutations from `recordZones` between the two queries
      // would otherwise produce inconsistent rows.
      const live = levelRegistry.rawForSymbol(symbol);
      const liveIds = new Set(live.map((l) => l.id));
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`DELETE FROM liquidity_levels WHERE symbol = ${symbol} AND id NOT IN (${sql.join(
              liveIds.size > 0
                ? Array.from(liveIds).map((id) => sql`${id}`)
                : [sql`''`],
              sql`,`,
            )})`,
          );
          if (live.length === 0) return;
          const values = live.map((l) => rowFromMem(l));
          await tx
            .insert(liquidityLevelsTable)
            .values(values)
            .onConflictDoUpdate({
              target: liquidityLevelsTable.id,
              set: {
                tier: sql`excluded.tier`,
                price: sql`excluded.price`,
                strength: sql`excluded.strength`,
                reliability: sql`excluded.reliability`,
                lastConfirmedAt: sql`excluded.last_confirmed_at`,
                touches: sql`excluded.touches`,
                methodsJson: sql`excluded.methods_json`,
              },
            });
        });
      } catch (e) {
        logger.warn({ err: e, symbol }, "level-registry: persist failed");
        // Re-mark dirty so the next tick retries this symbol; otherwise
        // we'd silently drop the write.
        levelRegistry.markDirty(symbol);
      }
    }
  } finally {
    inflight = false;
  }
}

export function startRegistryPersistence(): void {
  if (timer) return;
  timer = setInterval(() => {
    void persistDirty();
  }, PERSIST_INTERVAL_MS);
}

export function stopRegistryPersistence(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
