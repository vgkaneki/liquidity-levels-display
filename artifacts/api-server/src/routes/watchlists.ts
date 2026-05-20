import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { watchlistsTable, watchlistSymbolsTable } from "@workspace/db/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  ensureUserDefaultWatchlist,
  resolveWatchlistId,
} from "../services/watchlistSeed";
import { getUserId } from "../auth/requireAuth";

const router: IRouter = Router();

// watchlistInputHardeningV1: route-boundary validation only. This does not
// touch liquidity/structural formulas, confluence/scoring, DOM/Bookmap,
// absorption, touch classification, or level placement math.
const MAX_WATCHLIST_NAME_LEN = 64;
const MAX_SYMBOL_LEN = 32;
const MAX_REORDER_SYMBOLS = 500;
const SYMBOL_RE = /^[A-Z0-9]{2,32}$/;

function canonicalize(symbol: string): string {
  return symbol.replace(/-/g, "").toUpperCase();
}

function readWatchlistName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_WATCHLIST_NAME_LEN) return null;
  return name;
}

function readSymbol(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_SYMBOL_LEN) return null;
  const symbol = canonicalize(raw.trim());
  if (!SYMBOL_RE.test(symbol)) return null;
  return symbol;
}

// Verify that the given watchlist id is owned by the given user.
// Returns the watchlist row if owned, null otherwise. Centralized so
// every mutating handler enforces the same IDOR guard.
async function loadOwnedWatchlist(userId: string, watchlistId: string) {
  const rows = await db
    .select()
    .from(watchlistsTable)
    .where(
      and(
        eq(watchlistsTable.id, watchlistId),
        eq(watchlistsTable.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

router.get("/watchlists", async (req, res) => {
  const uid = getUserId(req);
  // Lazy-seed the user's default watchlist on first GET so a freshly-
  // registered account always sees BTC/ETH/SOL in the panel.
  await ensureUserDefaultWatchlist(uid);
  const lists = await db
    .select()
    .from(watchlistsTable)
    .where(eq(watchlistsTable.userId, uid));
  // Pull every symbol row for THIS user's lists in one query.
  const listIds = new Set(lists.map((l) => l.id));
  const allSymbols = listIds.size === 0
    ? []
    : await db.select().from(watchlistSymbolsTable).orderBy(asc(watchlistSymbolsTable.position));
  const grouped = new Map<string, typeof allSymbols>();
  for (const s of allSymbols) {
    if (!listIds.has(s.watchlistId)) continue;
    const arr = grouped.get(s.watchlistId) ?? [];
    arr.push(s);
    grouped.set(s.watchlistId, arr);
  }
  res.json({
    watchlists: lists.map((l) => ({
      // Surface the watchlist as "default" to the frontend if it's the
      // user's primary list — keeps the existing client code that
      // hardcodes the magic id working without a frontend change.
      id: l.name === "Default" ? "default" : l.id,
      realId: l.id,
      name: l.name,
      createdAt: l.createdAt,
      symbols: (grouped.get(l.id) ?? []).map((s) => ({ id: s.id, symbol: s.symbol, position: s.position })),
    })),
  });
});

router.post("/watchlists", async (req, res) => {
  const uid = getUserId(req);
  const name = readWatchlistName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Valid watchlist name required." });
    return;
  }
  const row = { id: randomUUID(), name, userId: uid, createdAt: Date.now() };
  await db.insert(watchlistsTable).values(row);
  res.json({ watchlist: { ...row, symbols: [] } });
});

router.put("/watchlists/:id", async (req, res) => {
  const uid = getUserId(req);
  const id = await resolveWatchlistId(uid, req.params.id);
  const owned = await loadOwnedWatchlist(uid, id);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const name = readWatchlistName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Valid watchlist name required." });
    return;
  }
  await db.update(watchlistsTable).set({ name }).where(eq(watchlistsTable.id, id));
  res.json({ ok: true });
});

router.delete("/watchlists/:id", async (req, res) => {
  const uid = getUserId(req);
  const id = await resolveWatchlistId(uid, req.params.id);
  const owned = await loadOwnedWatchlist(uid, id);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(watchlistSymbolsTable).where(eq(watchlistSymbolsTable.watchlistId, id));
  await db.delete(watchlistsTable).where(eq(watchlistsTable.id, id));
  res.json({ ok: true });
});

router.post("/watchlists/:id/symbols", async (req, res) => {
  const uid = getUserId(req);
  const id = await resolveWatchlistId(uid, req.params.id);
  const owned = await loadOwnedWatchlist(uid, id);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const canonical = readSymbol(req.body?.symbol);
  if (!canonical) {
    res.status(400).json({ error: "Valid symbol required." });
    return;
  }
  const existing = await db
    .select()
    .from(watchlistSymbolsTable)
    .where(and(eq(watchlistSymbolsTable.watchlistId, id), eq(watchlistSymbolsTable.symbol, canonical)));
  if (existing.length > 0) {
    res.json({ ok: true, duplicate: true });
    return;
  }
  const all = await db.select().from(watchlistSymbolsTable).where(eq(watchlistSymbolsTable.watchlistId, id));
  const position = all.reduce((m, s) => Math.max(m, s.position), -1) + 1;
  const row = {
    id: randomUUID(),
    watchlistId: id,
    symbol: canonical,
    position,
    addedAt: Date.now(),
  };
  await db.insert(watchlistSymbolsTable).values(row);
  res.json({ symbol: row });
});

router.post("/watchlists/:id/reorder", async (req, res) => {
  const uid = getUserId(req);
  const id = await resolveWatchlistId(uid, req.params.id);
  const owned = await loadOwnedWatchlist(uid, id);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = req.body ?? {};
  if (!Array.isArray(body.symbols) || body.symbols.length > MAX_REORDER_SYMBOLS) {
    res.status(400).json({ error: "Valid symbols array required." });
    return;
  }
  const seen = new Set<string>();
  const order = (body.symbols as unknown[])
    .map(readSymbol)
    .filter((s): s is string => Boolean(s))
    .filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  if (order.length === 0 && body.symbols.length > 0) {
    res.status(400).json({ error: "Valid symbols array required." });
    return;
  }
  const existing = await db.select().from(watchlistSymbolsTable).where(eq(watchlistSymbolsTable.watchlistId, id));
  const bySym = new Map(existing.map((r) => [r.symbol, r]));
  let pos = 0;
  for (const sym of order) {
    const row = bySym.get(sym);
    if (!row) continue;
    await db.update(watchlistSymbolsTable).set({ position: pos }).where(eq(watchlistSymbolsTable.id, row.id));
    bySym.delete(sym);
    pos++;
  }
  const tail = Array.from(bySym.values()).sort((a, b) => a.position - b.position);
  for (const row of tail) {
    await db.update(watchlistSymbolsTable).set({ position: pos }).where(eq(watchlistSymbolsTable.id, row.id));
    pos++;
  }
  res.json({ ok: true });
});

router.delete("/watchlists/:id/symbols/:symbol", async (req, res) => {
  const uid = getUserId(req);
  const id = await resolveWatchlistId(uid, req.params.id);
  const owned = await loadOwnedWatchlist(uid, id);
  if (!owned) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const canonical = readSymbol(req.params.symbol);
  if (!canonical) {
    res.status(400).json({ error: "Valid symbol required." });
    return;
  }
  await db
    .delete(watchlistSymbolsTable)
    .where(and(eq(watchlistSymbolsTable.watchlistId, id), eq(watchlistSymbolsTable.symbol, canonical)));
  res.json({ ok: true });
});

export default router;
