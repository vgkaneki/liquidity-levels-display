import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGetMarketOverview } from "@workspace/api-client-react";
import { useChannelSnapshot } from "@/hooks/useChannel";
import {
  Plus, MoreHorizontal, ChevronDown, Search, Star, X, Grid2x2,
  Pencil, ExternalLink, ArrowLeft, SlidersHorizontal, RefreshCw,
  ChevronUp,
} from "lucide-react";
import {
  addSymbolToDefault,
  removeSymbolFromDefault,
  reorderDefault,
  fetchDefaultWatchlistSymbols,
} from "@/lib/watchlistApi";
import { canonicalizeUiSymbol } from "@/datafeed/normalize";
import { fetchUniverseRows, topAndMajor, type UniverseRow } from "@/lib/universeApi";

// Single-installation architecture: the server DB is the only source of
// truth for watchlist membership and order. We intentionally do NOT cache
// the list in localStorage — stale client caches would diverge from the
// shared server state after another device mutates it. listName is UI
// chrome only, so it's still ok to keep local.
const WATCHLIST_NAME_KEY = "thermal:watchlist_name";
const DEFAULT_WATCHLIST = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];

const ALL_SYMBOLS = [
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "XRP-USDT", "DOGE-USDT",
  "ADA-USDT", "AVAX-USDT", "LINK-USDT", "DOT-USDT", "MATIC-USDT", "NEAR-USDT",
  "APT-USDT", "ARB-USDT", "OP-USDT", "SUI-USDT", "TIA-USDT", "SEI-USDT",
  "INJ-USDT", "FET-USDT", "JUP-USDT", "WIF-USDT", "PEPE-USDT", "SHIB-USDT",
  "LTC-USDT", "BCH-USDT", "ATOM-USDT", "UNI-USDT", "AAVE-USDT",
];

interface WatchlistPanelProps {
  symbol: string;
  onSelectSymbol: (symbol: string) => void;
  initialView?: "watchlist" | "screener";
}

interface FilterChip {
  id: string;
  field: "priceChange24h" | "markPrice" | "volume24h" | "openInterest";
  op: ">" | "<" | ">=" | "<=";
  value: number;
}

const FILTER_LABEL: Record<FilterChip["field"], string> = {
  priceChange24h: "24h Change %",
  markPrice: "Price",
  volume24h: "24h Volume",
  openInterest: "Open Interest",
};

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toExponential(2);
}

function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function WatchlistPanel({ symbol, onSelectSymbol, initialView = "watchlist" }: WatchlistPanelProps) {
  const [view, setView] = useState<"watchlist" | "screener">(initialView);
  // Watchlist is hydrated from the server on mount. We start empty so
  // the UI never renders stale cached entries — an empty list is a
  // valid server state (user cleared it) and we must honour it.
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [listName, setListName] = useState<string>(() => {
    try { return localStorage.getItem(WATCHLIST_NAME_KEY) ?? "My List"; } catch { return "My List"; }
  });
  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [filters, setFilters] = useState<FilterChip[]>([]);
  const [showAddFilter, setShowAddFilter] = useState(false);
  const [screenerSearch, setScreenerSearch] = useState("");
  const [universe, setUniverse] = useState<UniverseRow[]>([]);
  const moreRef = useRef<HTMLDivElement>(null);

  // Reconcile local state with the server. Any caller can trigger this
  // after a mutation to make sure what the user sees matches the DB.
  const reconcile = useCallback(async () => {
    const remote = await fetchDefaultWatchlistSymbols();
    if (remote === null) return; // network error — keep current state
    setWatchlist(remote);
  }, []);

  // Bootstrap from REST once on mount. Server is authoritative; if it
  // returns an empty list we honour that (do NOT re-seed from cache).
  useEffect(() => { void reconcile(); }, [reconcile]);

  useEffect(() => {
    try { localStorage.setItem(WATCHLIST_NAME_KEY, listName); } catch {}
  }, [listName]);

  // Shared fetcher: pulls the latest universe snapshot from the same
  // endpoint SymbolSearch uses. Returns [] on any failure so callers
  // can safely no-op.
  const fetchUniverse = useCallback(async (): Promise<UniverseRow[]> => {
    return fetchUniverseRows();
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  // Universe load — used by the screener list and by the refresh button.
  // We no longer auto-seed the watchlist from the universe; the server
  // owns default-list composition (see watchlistSeed.ts on the API
  // side), so the client just displays whatever the server returns.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchUniverse();
      if (cancelled) return;
      if (rows.length > 0) setUniverse(rows);
    })();
    return () => { cancelled = true; };
  }, [fetchUniverse]);

  // Manual refresh: refetch the universe LIVE so we discover symbols
  // that have been promoted into Top/Major since page load, then POST
  // additions to the server and reconcile back from it. The server is
  // the single source of truth — any additions become visible to other
  // clients immediately.
  const refreshFromUniverse = useCallback(async () => {
    setRefreshing(true);
    try {
      const rows = await fetchUniverse();
      if (rows.length === 0) return;
      setUniverse(rows);
      const candidates = topAndMajor(rows);
      const have = new Set(watchlist);
      const additions = candidates.filter((s) => !have.has(s));
      for (const s of additions) {
        // Best-effort parallel writes; reconcile will reflect actual state.
        void addSymbolToDefault(s);
      }
      if (additions.length > 0) {
        // Small delay so the server has a chance to commit all additions
        // before we re-read. If any failed, reconcile will reveal it.
        await new Promise((r) => setTimeout(r, 150));
        await reconcile();
      }
    } finally {
      setRefreshing(false);
    }
  }, [fetchUniverse, watchlist, reconcile]);

  useEffect(() => {
    if (!showMore) return;
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMore(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showMore]);

  // REST cold-start so the panel has data immediately on mount, then the
  // `market:overview` WS channel pushes deltas as exchange ticks land.
  const { data: apiData } = useGetMarketOverview({
    query: { refetchInterval: false },
  } as never);
  const { data: liveOverview } = useChannelSnapshot<typeof apiData>("market:overview");
  // Real-only price map. When the overview is empty (cold start or
  // upstream outage), `priceMap` is empty and the rows render with
  // dash placeholders rather than fabricated quotes.
  const data = liveOverview ?? apiData;

  const priceMap = useMemo(() => {
    const m = new Map<string, { price: number; chgPct: number; vol: number; oi: number }>();
    for (const it of data?.mostLiquid ?? []) {
      m.set(it.symbol, {
        price: it.markPrice,
        chgPct: it.priceChange24h,
        vol: it.volume24h,
        oi: it.openInterest,
      });
    }
    return m;
  }, [data]);

  // All mutations optimistically update local state for instant feedback,
  // then write to the server, then reconcile from the server response.
  // If the server rejects, reconcile will roll us back to the true state.
  const addSymbol = (s: string) => {
    const norm = canonicalizeUiSymbol(s);
    setWatchlist((w) => (w.includes(norm) ? w : [...w, norm]));
    setShowAdd(false);
    setAddQuery("");
    void (async () => {
      await addSymbolToDefault(norm);
      await reconcile();
    })();
  };
  const removeSymbol = (s: string) => {
    setWatchlist((w) => w.filter((x) => x !== s));
    void (async () => {
      await removeSymbolFromDefault(s);
      await reconcile();
    })();
  };
  const move = (s: string, dir: -1 | 1) => {
    setWatchlist((w) => {
      const i = w.indexOf(s);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= w.length) return w;
      const next = w.slice();
      next[i] = w[j];
      next[j] = w[i];
      void (async () => {
        await reorderDefault(next);
        await reconcile();
      })();
      return next;
    });
  };

  const filteredAdd = useMemo(() => {
    const q = addQuery.toUpperCase();
    return ALL_SYMBOLS.filter((s) => !watchlist.includes(s) && s.includes(q)).slice(0, 12);
  }, [addQuery, watchlist]);

  // ---------- header ----------
  const Header = (
    <div className="h-10 border-b border-border flex items-center justify-between px-2 gap-1 bg-card">
      {view === "screener" ? (
        <>
          <button
            onClick={() => setView("watchlist")}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 flex items-center gap-1">
            <span className="text-xs font-bold text-foreground tracking-wide">SCREENER</span>
          </div>
          <button
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
            title="Settings"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        </>
      ) : (
        <>
          {editingName ? (
            <input
              autoFocus
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingName(false); }}
              className="flex-1 bg-input text-xs text-foreground px-2 py-1 rounded border border-border outline-none"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary px-1"
              title="Rename list"
            >
              <span className="truncate max-w-[110px]">{listName}</span>
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>
          )}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setShowAdd((s) => !s)}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
              title="Add symbol"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={refreshFromUniverse}
              disabled={refreshing}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Refresh from universe (fetch latest top + major symbols)"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setView("screener")}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
              title="Open screener"
            >
              <Grid2x2 className="w-4 h-4" />
            </button>
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setShowMore((s) => !s)}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                title="More"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {showMore && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-popover border border-border rounded shadow-lg z-30 py-1 text-xs">
                  <button
                    onClick={() => { setEditingName(true); setShowMore(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-foreground text-left"
                  >
                    <Pencil className="w-3 h-3" /> Rename list
                  </button>
                  <button
                    onClick={() => {
                      const prev = watchlist;
                      setWatchlist([]);
                      setShowMore(false);
                      void (async () => {
                        for (const s of prev) await removeSymbolFromDefault(s);
                        await reconcile();
                      })();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-foreground text-left"
                  >
                    <X className="w-3 h-3" /> Clear all
                  </button>
                  <button
                    onClick={() => {
                      const prev = watchlist;
                      setWatchlist(DEFAULT_WATCHLIST);
                      setShowMore(false);
                      void (async () => {
                        // Clear then add defaults so server order matches.
                        for (const s of prev) await removeSymbolFromDefault(s);
                        for (const s of DEFAULT_WATCHLIST) await addSymbolToDefault(s);
                        await reconcile();
                      })();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-foreground text-left"
                  >
                    <Star className="w-3 h-3" /> Reset defaults
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );

  // ---------- watchlist body ----------
  const selected = symbol;
  const selectedRow = priceMap.get(selected);

  const WatchlistBody = (
    <>
      {showAdd && (
        <div className="border-b border-border bg-popover/95 px-2 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              autoFocus
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              placeholder="Search symbol…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-input border border-border rounded outline-none"
            />
          </div>
          <div className="mt-1 max-h-48 overflow-y-auto">
            {filteredAdd.length === 0 ? (
              <div className="text-[10px] text-muted-foreground px-2 py-2">No matches</div>
            ) : (
              filteredAdd.map((s) => (
                <button
                  key={s}
                  onClick={() => addSymbol(s)}
                  className="w-full flex items-center justify-between px-2 py-1.5 text-xs hover:bg-accent text-foreground"
                >
                  <span className="font-mono">{s}</span>
                  <Plus className="w-3 h-3 opacity-60" />
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_auto_auto] px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border gap-2">
        <span>Symbol</span>
        <span className="text-right">Last</span>
        <span className="text-right">Chg</span>
        <span className="text-right">Chg%</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">
        {watchlist.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-muted-foreground">
            Empty watchlist. Click <Plus className="w-3 h-3 inline" /> to add.
          </div>
        ) : (
          watchlist.map((s) => {
            const row = priceMap.get(s);
            const chg = row?.chgPct ?? 0;
            const isPos = chg >= 0;
            const isSel = s === selected;
            return (
              <div
                key={s}
                onClick={() => onSelectSymbol(s)}
                className={`group grid grid-cols-[1fr_auto_auto_auto] items-center px-2 py-1.5 gap-2 cursor-pointer text-xs border-b border-border/30 ${
                  isSel ? "bg-primary/10" : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); removeSymbol(s); }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 shrink-0"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); move(s, -1); }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                    title="Move up"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); move(s, 1); }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                    title="Move down"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  <span className="font-medium text-foreground truncate">{s}</span>
                </div>
                <span className="text-right tabular-nums text-foreground">
                  {row ? formatPrice(row.price) : "—"}
                </span>
                <span className={`text-right tabular-nums ${row ? (isPos ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
                  {row ? `${isPos ? "+" : ""}${(row.price * (chg / 100)).toFixed(2)}` : "—"}
                </span>
                <span className={`text-right tabular-nums ${row ? (isPos ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
                  {row ? `${isPos ? "+" : ""}${chg.toFixed(2)}%` : "—"}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* selected detail card */}
      {selectedRow && (
        <div className="border-t border-border p-3 bg-card/60 shrink-0">
          <div className="flex items-start justify-between mb-1">
            <div className="min-w-0">
              <div className="text-sm font-bold text-foreground truncate">{selected}</div>
              <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                Perpetual
                <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                <span className="opacity-60">•</span>
                <span>OKX</span>
              </div>
            </div>
            <span className="text-[10px] text-green-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Live
            </span>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-foreground tabular-nums">
              {formatPrice(selectedRow.price)}
            </span>
            <span className="text-[10px] text-muted-foreground">USDT</span>
            <span className={`text-xs tabular-nums ${selectedRow.chgPct >= 0 ? "text-green-400" : "text-red-400"}`}>
              {selectedRow.chgPct >= 0 ? "+" : ""}{(selectedRow.price * (selectedRow.chgPct / 100)).toFixed(2)}{" "}
              {selectedRow.chgPct >= 0 ? "+" : ""}{selectedRow.chgPct.toFixed(2)}%
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
            <div>
              <div className="text-muted-foreground uppercase tracking-wider">24h Vol</div>
              <div className="text-foreground tabular-nums font-medium">${formatBig(selectedRow.vol)}</div>
            </div>
            <div>
              <div className="text-muted-foreground uppercase tracking-wider">Open Int</div>
              <div className="text-foreground tabular-nums font-medium">${formatBig(selectedRow.oi)}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ---------- screener body ----------
  const screenerRows = useMemo(() => {
    let rows = (data?.mostLiquid ?? []).map((it) => ({
      symbol: it.symbol,
      price: it.markPrice,
      chgPct: it.priceChange24h,
      vol: it.volume24h,
      oi: it.openInterest,
    }));
    if (screenerSearch.trim()) {
      const q = screenerSearch.toUpperCase();
      rows = rows.filter((r) => r.symbol.toUpperCase().includes(q));
    }
    for (const f of filters) {
      const fieldMap = { priceChange24h: "chgPct", markPrice: "price", volume24h: "vol", openInterest: "oi" } as const;
      const k = fieldMap[f.field];
      rows = rows.filter((r) => {
        const v = r[k];
        if (f.op === ">") return v > f.value;
        if (f.op === "<") return v < f.value;
        if (f.op === ">=") return v >= f.value;
        return v <= f.value;
      });
    }
    return rows;
  }, [data, filters, screenerSearch]);

  const ScreenerBody = (
    <>
      <div className="border-b border-border px-2 py-2 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1 px-2 py-1 text-xs bg-input border border-border rounded hover:bg-accent">
            Watchlist <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          <button
            onClick={() => setShowAddFilter((s) => !s)}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-primary/15 border border-primary/30 text-primary rounded hover:bg-primary/25"
          >
            <Plus className="w-3 h-3" /> Add filter
          </button>
        </div>

        {showAddFilter && (
          <FilterEditor
            onAdd={(f) => { setFilters((arr) => [...arr, f]); setShowAddFilter(false); }}
            onCancel={() => setShowAddFilter(false)}
          />
        )}

        {filters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => (
              <span
                key={f.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-accent rounded font-mono text-foreground"
              >
                {FILTER_LABEL[f.field]} {f.op} {f.value}
                <button
                  onClick={() => setFilters((arr) => arr.filter((x) => x.id !== f.id))}
                  className="text-muted-foreground hover:text-red-400"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            value={screenerSearch}
            onChange={(e) => setScreenerSearch(e.target.value)}
            placeholder={`Symbol  ${screenerRows.length}`}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-input border border-border rounded outline-none"
          />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border gap-2 shrink-0">
        <span>Symbol</span>
        <span className="text-right">Price</span>
        <span className="text-right">Change %</span>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">
        {screenerRows.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-muted-foreground">No results</div>
        ) : (
          screenerRows.map((r) => {
            const isPos = r.chgPct >= 0;
            return (
              <div
                key={r.symbol}
                onClick={() => onSelectSymbol(r.symbol)}
                className="grid grid-cols-[1fr_auto_auto] items-center px-2 py-1.5 gap-2 cursor-pointer text-xs hover:bg-accent/50 border-b border-border/30"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); addSymbol(r.symbol); }}
                    className="text-muted-foreground hover:text-yellow-400 shrink-0"
                    title="Add to watchlist"
                  >
                    <Star className="w-3 h-3" />
                  </button>
                  <span className="font-medium text-foreground truncate">{r.symbol}</span>
                </div>
                <span className="text-right tabular-nums text-foreground">{formatPrice(r.price)}</span>
                <span className={`text-right tabular-nums ${isPos ? "text-green-400" : "text-red-400"}`}>
                  {isPos ? "+" : ""}{r.chgPct.toFixed(2)}%
                </span>
              </div>
            );
          })
        )}
      </div>
    </>
  );

  return (
    <div className="w-72 border-l border-border bg-card flex flex-col shrink-0">
      {Header}
      {view === "watchlist" ? WatchlistBody : ScreenerBody}
    </div>
  );
}

function FilterEditor({ onAdd, onCancel }: { onAdd: (f: FilterChip) => void; onCancel: () => void }) {
  const [field, setField] = useState<FilterChip["field"]>("priceChange24h");
  const [op, setOp] = useState<FilterChip["op"]>(">");
  const [value, setValue] = useState<string>("0");
  return (
    <div className="bg-popover border border-border rounded p-2 space-y-1.5">
      <div className="flex gap-1">
        <select
          value={field}
          onChange={(e) => setField(e.target.value as FilterChip["field"])}
          className="flex-1 text-[11px] bg-input border border-border rounded px-1 py-1 outline-none"
        >
          <option value="priceChange24h">24h Change %</option>
          <option value="markPrice">Price</option>
          <option value="volume24h">24h Volume</option>
          <option value="openInterest">Open Interest</option>
        </select>
        <select
          value={op}
          onChange={(e) => setOp(e.target.value as FilterChip["op"])}
          className="text-[11px] bg-input border border-border rounded px-1 py-1 outline-none"
        >
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&ge;</option>
          <option value="<=">&le;</option>
        </select>
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-16 text-[11px] bg-input border border-border rounded px-1 py-1 outline-none tabular-nums"
        />
      </div>
      <div className="flex justify-end gap-1">
        <button
          onClick={onCancel}
          className="px-2 py-0.5 text-[11px] hover:bg-accent rounded text-muted-foreground"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const v = Number(value);
            if (Number.isFinite(v)) {
              onAdd({ id: Math.random().toString(36).slice(2), field, op, value: v });
            }
          }}
          className="px-2 py-0.5 text-[11px] bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30"
        >
          Add
        </button>
      </div>
    </div>
  );
}
