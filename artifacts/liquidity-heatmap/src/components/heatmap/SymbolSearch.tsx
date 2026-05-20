import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Star } from "lucide-react";
import { canonicalizeUiSymbol } from "@/datafeed/normalize";
import { FALLBACK_SYMBOLS, fetchUniverseItems, type ExchangeTag, type SymbolItem } from "@/lib/universeApi";
import { apiUrl } from "@/lib/api";

interface SymbolSearchProps {
  value: string;
  onChange: (symbol: string) => void;
}

export function SymbolSearch({ value, onChange }: SymbolSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [items, setItems] = useState<SymbolItem[]>(FALLBACK_SYMBOLS);
  const [loaded, setLoaded] = useState(false);
  // Symbols currently in the default watchlist — used to render the star
  // state inline so users can one-click pin/unpin the symbol they're
  // searching without leaving the picker.
  const [watchSymbols, setWatchSymbols] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadWatch = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/watchlists`), { credentials: "include" });
      if (!res.ok) return;
      const body = (await res.json()) as { watchlists?: { id: string; symbols: { symbol: string }[] }[] };
      const def = body.watchlists?.find((w) => w.id === "default");
      setWatchSymbols(new Set((def?.symbols ?? []).map((s) => canonicalizeUiSymbol(s.symbol))));
    } catch {
      // non-fatal — star display just won't reflect server state
    }
  }, []);
  useEffect(() => { void loadWatch(); }, [loadWatch]);

  const toggleStar = useCallback(async (displaySymbol: string) => {
    const canonical = canonicalizeUiSymbol(displaySymbol);
    const isStarred = watchSymbols.has(canonical);
    // Optimistic update so the click feels instant.
    setWatchSymbols((prev) => {
      const next = new Set(prev);
      if (isStarred) next.delete(canonical); else next.add(canonical);
      return next;
    });
    try {
      if (isStarred) {
        await fetch(apiUrl(`/api/watchlists/default/symbols/${encodeURIComponent(canonical)}`), {
          method: "DELETE",
          credentials: "include",
        });
      } else {
        await fetch(apiUrl(`/api/watchlists/default/symbols`), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol: canonical }),
        });
      }
    } catch {
      // Rollback on failure.
      void loadWatch();
    }
  }, [watchSymbols, loadWatch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const universeItems = await fetchUniverseItems();
      if (cancelled) return;
      if (universeItems.length > 0) {
        setItems(universeItems);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!query) return items;
    const q = query.toUpperCase();
    return items.filter((s) => s.base.includes(q) || s.symbol.includes(q));
  }, [query, items]);

  useEffect(() => { setHighlightIdx(0); }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open && listRef.current) {
      const item = listRef.current.children[highlightIdx] as HTMLElement;
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx, open]);

  const selectSymbol = (sym: string) => {
    onChange(sym);
    setOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIdx]) selectSymbol(filtered[highlightIdx].symbol);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const tierColor = (tier: number) => {
    if (tier === 1) return "text-yellow-400";
    if (tier === 2) return "text-cyan-400";
    if (tier === 3) return "text-slate-300";
    return "text-slate-500";
  };

  const tierLabel = (tier: number) => {
    if (tier === 1) return "★";
    if (tier === 2) return "◆";
    return "";
  };

  const exchangeBadge = (ex: ExchangeTag) => {
    if (ex === "okx") return "O";
    if (ex === "hyperliquid") return "H";
    return "T";
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="flex items-center gap-2 h-8 px-3 text-xs font-mono bg-accent border border-border rounded-md hover:bg-accent/80 transition-colors min-w-[180px]"
      >
        <span className="text-cyan-400">{value}</span>
        <svg className="w-3 h-3 ml-auto text-muted-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 5l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-[320px] bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={loaded ? "Search symbol..." : "Loading universe..."}
              className="w-full h-7 px-2 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-cyan-500 text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} className="max-h-[320px] overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No symbols found
              </div>
            )}
            {filtered.map((item, idx) => {
              const canonical = item.symbol.replace(/-/g, "").toUpperCase();
              const isStarred = watchSymbols.has(canonical);
              return (
              <div
                key={item.symbol}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono transition-colors ${
                  idx === highlightIdx ? "bg-accent/80" : "hover:bg-accent/40"
                } ${value === item.symbol ? "text-cyan-400" : ""}`}
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void toggleStar(item.symbol); }}
                  title={isStarred ? "Remove from watchlist" : "Add to watchlist"}
                  data-testid={`star-${canonical}`}
                  className={`shrink-0 p-0.5 rounded hover:bg-white/10 ${isStarred ? "text-yellow-300" : "text-white/30 hover:text-yellow-200"}`}
                >
                  <Star className="w-3 h-3" fill={isStarred ? "currentColor" : "none"} />
                </button>
                <button
                  type="button"
                  onClick={() => selectSymbol(item.symbol)}
                  className="flex-1 flex items-center gap-2 text-left"
                >
                  <span className={`w-3 text-center ${tierColor(item.tier)}`}>
                    {tierLabel(item.tier)}
                  </span>
                  <span className={tierColor(item.tier)}>{item.base}</span>
                  <span className="text-muted-foreground">/USDT</span>
                  <span className="ml-auto flex items-center gap-0.5">
                    {item.exchanges.map((ex) => (
                      <span
                        key={ex}
                        title={ex}
                        className="inline-flex items-center justify-center w-3.5 h-3.5 text-[9px] rounded-sm bg-slate-700/60 text-slate-300"
                      >
                        {exchangeBadge(ex)}
                      </span>
                    ))}
                  </span>
                  {value === item.symbol && (
                    <span className="text-cyan-400">✓</span>
                  )}
                </button>
              </div>
              );
            })}
          </div>
          <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground font-mono flex items-center justify-between">
            <span>{filtered.length} symbols · ★ top · ◆ major</span>
            <span className="text-slate-500">O · H · T</span>
          </div>
        </div>
      )}
    </div>
  );
}
