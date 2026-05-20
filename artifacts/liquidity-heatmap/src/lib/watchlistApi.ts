// REST-backed watchlist persistence. The server DB is the single source of
// truth for watchlist membership and order — this project is a single-
// installation app and every client must see identical state immediately
// after login or reload. These helpers surface success/failure so callers
// can reconcile optimistic UI with the server response.

import { canonicalizeUiSymbol, toDisplayUsdtSymbol } from "@/datafeed/normalize";
import { apiUrl } from "@/lib/api";
const DEFAULT_ID = "default";

interface WatchlistRow {
  id: string;
  name: string;
  createdAt: number;
  symbols: { id: string; symbol: string; position: number }[];
}

function canonicalize(symbol: string): string {
  return canonicalizeUiSymbol(symbol);
}

export async function fetchDefaultWatchlistSymbols(): Promise<string[] | null> {
  try {
    const res = await fetch(apiUrl(`/api/watchlists`), {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { watchlists: WatchlistRow[] };
    const def = body.watchlists.find((w) => w.id === DEFAULT_ID) ?? body.watchlists[0];
    if (!def) return [];
    return def.symbols.map((s) => toDisplayUsdtSymbol(s.symbol));
  } catch {
    return null;
  }
}

export async function addSymbolToDefault(symbolDashed: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`/api/watchlists/${DEFAULT_ID}/symbols`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: canonicalize(symbolDashed) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function removeSymbolFromDefault(symbolDashed: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`/api/watchlists/${DEFAULT_ID}/symbols/${encodeURIComponent(canonicalize(symbolDashed))}`), {
      method: "DELETE",
      credentials: "include",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function reorderDefault(symbolsDashed: string[]): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`/api/watchlists/${DEFAULT_ID}/reorder`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: symbolsDashed.map(canonicalize) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
