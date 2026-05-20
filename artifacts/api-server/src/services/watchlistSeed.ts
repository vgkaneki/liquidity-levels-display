import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { watchlistsTable, watchlistSymbolsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// Per-user default watchlist seed. The frontend treats "default" as a
// stable logical alias for "this user's primary watchlist" — the route
// layer in routes/watchlists.ts resolves that alias to the real UUID
// of the per-user row that this seeder creates.
//
// Pre-multi-user installs had a single shared watchlist with id
// "default" and userId NULL. Those rows are NOT migrated to any user;
// they remain unreachable in the table (preserved for forensic
// recovery, not for any new code path).
export const DEFAULT_WATCHLIST_NAME = "Default";
export const DEFAULT_WATCHLIST_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

/**
 * Idempotent. Guarantees that the given user owns at least one
 * watchlist named "Default", seeded with the canonical starter symbol
 * set on first creation. Returns the resolved watchlist id (UUID) so
 * callers (e.g. routes that received `:id === "default"` as an alias)
 * can immediately operate on the row.
 *
 * Safe to call on every request that needs the user's default
 * watchlist — the fast path is a single indexed SELECT.
 */
export async function ensureUserDefaultWatchlist(userId: string): Promise<string> {
  if (!userId || typeof userId !== "string") {
    throw new Error("ensureUserDefaultWatchlist requires a userId");
  }
  try {
    const existing = await db
      .select({ id: watchlistsTable.id })
      .from(watchlistsTable)
      .where(
        and(
          eq(watchlistsTable.userId, userId),
          eq(watchlistsTable.name, DEFAULT_WATCHLIST_NAME),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0]!.id;

    const id = randomUUID();
    const now = Date.now();
    await db.insert(watchlistsTable).values({
      id,
      name: DEFAULT_WATCHLIST_NAME,
      userId,
      createdAt: now,
    });
    await db.insert(watchlistSymbolsTable).values(
      DEFAULT_WATCHLIST_SYMBOLS.map((sym, i) => ({
        id: randomUUID(),
        watchlistId: id,
        symbol: sym,
        position: i,
        addedAt: now,
      })),
    );
    logger.info({ userId, watchlistId: id }, "watchlist-seed: created per-user default");
    return id;
  } catch (e) {
    logger.warn({ err: e, userId }, "watchlist-seed: ensureUserDefault failed");
    throw e;
  }
}

/**
 * Resolve the magic alias "default" used by the frontend to the real
 * UUID of this user's primary watchlist. Returns the id as-is for any
 * other path param. Lazy-seeds the user's default if absent.
 */
export async function resolveWatchlistId(
  userId: string,
  rawId: string,
): Promise<string> {
  if (rawId === "default") return ensureUserDefaultWatchlist(userId);
  return rawId;
}
