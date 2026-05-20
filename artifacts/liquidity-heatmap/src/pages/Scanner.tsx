import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Play, Radio, AlertTriangle, Filter, X, SlidersHorizontal, Crosshair } from "lucide-react";
import { ScreenerFilterBar } from "@/components/scanner/ScreenerFilterBar";
import { LevelTouchPanel } from "@/components/scanner/LevelTouchPanel";
import { WatchlistPanel } from "@/components/heatmap/WatchlistPanel";
import { useChannel } from "@/hooks/useChannel";
import { normalizeSymbolKey } from "@/datafeed/normalize";
import {
  CATALOG_BY_ID,
  loadActiveFilters,
  saveActiveFilters,
  useScreenerCatalog,
  type ActiveFilter,
  type ScreenerCatalogEntry,
} from "@/lib/screenerCatalog";
import { apiUrl } from "@/lib/api";

interface FilterResult {
  actual: number | string | boolean | null;
  operator: string;
  value: unknown;
  passed: boolean;
}

interface ScanRow {
  symbol: string;
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  change_pct?: number | null;
  quote_volume?: number | null;
  sort_score?: number | null;
  match_score?: number | null;
  liquidity_bonus?: number | null;
  filter_results?: Record<string, FilterResult>;
}

type SortMode =
  | "best_match"
  | "highest_score"
  | "highest_volume"
  | "largest_pct_move";

const SORT_MODES: { value: SortMode; label: string; short: string }[] = [
  { value: "best_match", label: "Best match", short: "Best" },
  { value: "highest_score", label: "Highest score", short: "Score" },
  { value: "highest_volume", label: "Highest volume", short: "Vol" },
  { value: "largest_pct_move", label: "Largest % move", short: "Δ%" },
];

interface ScanResponse {
  ok?: boolean;
  error?: string;
  unsupported?: string[];
  matches?: ScanRow[];
  symbols_scanned?: number;
  exchange?: string;
  quote?: string;
  sort_by?: SortMode;
  errors?: Array<{ symbol: string; error: string }>;
  supported_filters_used?: string[];
}


async function postScan(payload: unknown): Promise<ScanResponse> {
  const res = await fetch(apiUrl(`/api/screener/scan`), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as ScanResponse;
  if (!res.ok) {
    throw new Error(data?.error || `scan failed: ${res.status}`);
  }
  return data;
}

function fmtNum(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.001) return n.toFixed(6);
  if (abs === 0) return "0";
  return n.toFixed(8);
}

function fmtCompact(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function fmtSortKey(r: ScanRow, mode: SortMode): string {
  if (mode === "highest_volume") return fmtCompact(r.quote_volume);
  if (mode === "largest_pct_move") {
    return typeof r.change_pct === "number" ? `${Math.abs(r.change_pct).toFixed(2)}%` : "—";
  }
  if (mode === "highest_score") {
    const v = r.match_score ?? r.sort_score;
    return typeof v === "number" ? v.toFixed(2) : "—";
  }
  return typeof r.sort_score === "number" ? r.sort_score.toFixed(2) : "—";
}

type ScannerMode = "filters" | "levels";

interface ScannerAlert {
  id: string;
  symbol: string;
  kind: string;
  price: number;
  message: string;
  emittedAt: number;
}

function ScannerAlertsBar() {
  // Live consumer of the `scanner:alerts` WS channel. The alert producer
  // is wired up in T002 (alerts); this UI is the consumer side
  // already subscribed so alerts flow in immediately when emitted.
  // Server contract: snapshot payload is `{ alerts: ScannerAlert[] }`,
  // delta payload is `{ alert: ScannerAlert }`.
  const [recent, setRecent] = useState<ScannerAlert[]>([]);
  useChannel<{ alerts?: ScannerAlert[]; alert?: ScannerAlert }>(
    "scanner:alerts",
    (payload, kind) => {
      if (!payload) return;
      if (kind === "snapshot" && Array.isArray(payload.alerts)) {
        setRecent(payload.alerts.slice(0, 5));
        return;
      }
      const a = payload.alert;
      if (!a || typeof a.id !== "string") return;
      setRecent((prev) => [a, ...prev.filter((p) => p.id !== a.id)].slice(0, 5));
    },
  );
  if (recent.length === 0) return null;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1 border-b border-cyan-500/20 bg-cyan-500/5 text-[11px] overflow-x-auto"
      data-testid="scanner-alerts-bar"
    >
      <span className="text-cyan-300/80 shrink-0">live alerts</span>
      {recent.map((a) => (
        <span key={a.id} className="text-white/80 whitespace-nowrap">
          <span className="text-cyan-200">{a.symbol}</span>
          {" · "}
          {a.message}
        </span>
      ))}
    </div>
  );
}

export default function Scanner() {
  const [mode, setMode] = useState<ScannerMode>(() => {
    try {
      const v = localStorage.getItem("thermal.scanner.mode.v1");
      return v === "levels" ? "levels" : "filters";
    } catch {
      return "filters";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("thermal.scanner.mode.v1", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  // Navigate to the heatmap page when the user picks a symbol from the
  // sidebar watchlist — the scanner page itself has no "active symbol".
  const [, navigate] = useLocation();
  const onPickSymbol = (s: string) => {
    const clean = normalizeSymbolKey(s);
    navigate(`/?symbol=${encodeURIComponent(clean)}`);
  };

  return (
    <div className="flex-1 bg-background overflow-hidden flex font-mono">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <div className="flex items-center gap-1 px-3 sm:px-4 py-1.5 border-b border-border bg-card shrink-0">
        <button
          onClick={() => setMode("filters")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border transition-colors ${
            mode === "filters"
              ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-200"
              : "bg-white/5 border-white/10 text-white/60 hover:text-white/80"
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
          Filter screener
        </button>
        <button
          onClick={() => setMode("levels")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border transition-colors ${
            mode === "levels"
              ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-200"
              : "bg-white/5 border-white/10 text-white/60 hover:text-white/80"
          }`}
        >
          <Crosshair className="w-3 h-3" />
          Level touch
        </button>
      </div>
      <ScannerAlertsBar />
      {mode === "filters" ? <FiltersScanner /> : <LevelTouchPanel />}
      </div>
      <aside
        className="hidden md:flex flex-col w-64 lg:w-72 shrink-0 border-l border-border bg-card overflow-hidden"
        data-testid="scanner-watchlist-sidebar"
      >
        <WatchlistPanel symbol="" onSelectSymbol={onPickSymbol} />
      </aside>
    </div>
  );
}

function FiltersScanner() {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>(() => loadActiveFilters());
  useEffect(() => { saveActiveFilters(activeFilters); }, [activeFilters]);

  const { catalog, byId, source } = useScreenerCatalog();
  const [exchange, setExchange] = useState<string>("binanceusdm");
  const [topN, setTopN] = useState<number>(20);
  const [sortBy, setSortBy] = useState<SortMode>("best_match");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const scan = useMutation({
    mutationFn: () => {
      // Send id+label so the engine can resolve via id-then-label.
      const filterPayload = activeFilters.map((f) => {
        const entry = (byId[f.catalogId] ?? CATALOG_BY_ID[f.catalogId]) as
          | ScreenerCatalogEntry
          | undefined;
        return {
          id: f.catalogId,
          label: entry?.label ?? f.catalogId,
          operator: f.operator,
          value: f.value,
          value2: f.value2,
          timeframe: entry?.timeframe ?? null,
        };
      });
      return postScan({
        exchange,
        quote: "USDT",
        top_n: topN,
        scan_limit: exchange === "toobit" ? Math.max(topN * 2, 40) : Math.max(topN * 8, 120),
        candle_limit: 300,
        sort_by: sortBy,
        filters: filterPayload,
      });
    },
  });

  const sortMeta = useMemo(
    () => SORT_MODES.find((m) => m.value === (scan.data?.sort_by ?? sortBy)) ?? SORT_MODES[0],
    [scan.data?.sort_by, sortBy],
  );

  const result = scan.data;
  const rows = result?.matches ?? [];

  const valueColumns = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const fr = r.filter_results;
      if (fr && typeof fr === "object") Object.keys(fr).forEach((k) => set.add(k));
    }
    return [...set].slice(0, 6);
  }, [rows]);

  const filterCount = activeFilters.length;

  return (
    <div className="flex-1 bg-background overflow-hidden flex flex-col font-mono">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 sm:px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          SCREENER
          <span className="text-[10px] text-white/30 hidden sm:inline">
            · catalog: {catalog.length} ({source})
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <label className="text-muted-foreground hidden sm:inline">EX</label>
          <select
            value={exchange}
            onChange={(e) => setExchange(e.target.value)}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none"
          >
            <option value="binanceusdm">Binance USDM (perps)</option>
            <option value="toobit">Toobit (perps)</option>
            <option value="binance">Binance Spot</option>
            <option value="bybit">Bybit</option>
            <option value="okx">OKX</option>
            <option value="kraken">Kraken</option>
          </select>
          <label className="text-muted-foreground hidden sm:inline ml-1">N</label>
          <input
            type="number"
            min={1}
            max={100}
            value={topN}
            onChange={(e) => setTopN(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 20)))}
            className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white text-[11px] outline-none tabular-nums"
          />
          <label className="text-muted-foreground hidden sm:inline ml-1">SORT</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortMode)}
            title="Sort results by"
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/80 text-[11px] outline-none"
          >
            {SORT_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>

        <button
          onClick={() => setMobileFiltersOpen(true)}
          className="sm:hidden flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-white/5 border border-white/10 text-white/80"
        >
          <Filter className="w-3 h-3" />
          Filters {filterCount > 0 ? `(${filterCount})` : ""}
        </button>

        <button
          onClick={() => scan.mutate()}
          disabled={scan.isPending || activeFilters.length === 0}
          className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded text-xs bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 disabled:hover:bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 transition-colors"
        >
          <Play className="w-3 h-3" />
          {scan.isPending ? "Scanning…" : "Run scan"}
        </button>
      </div>

      {/* Filter bar — desktop inline, mobile in drawer */}
      <div className="hidden sm:block">
        <ScreenerFilterBar filters={activeFilters} onChange={setActiveFilters} catalog={catalog} byId={byId} />
      </div>
      {mobileFiltersOpen && (
        <div className="sm:hidden fixed inset-0 z-40 bg-black/70 flex flex-col" onClick={() => setMobileFiltersOpen(false)}>
          <div
            className="mt-auto bg-zinc-950 border-t border-white/10 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span className="text-sm text-white">Filters</span>
              <button onClick={() => setMobileFiltersOpen(false)} className="text-white/60">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ScreenerFilterBar filters={activeFilters} onChange={setActiveFilters} catalog={catalog} byId={byId} />
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {scan.isError && (
          <div className="m-3 sm:m-4 p-3 rounded border border-rose-500/30 bg-rose-500/10 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{(scan.error as Error)?.message ?? "scan failed"}</span>
          </div>
        )}

        {result && result.ok === false && (
          <div className="m-3 sm:m-4 p-3 rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs">
            {result.error}
            {result.unsupported && result.unsupported.length > 0 && (
              <div className="mt-1 text-[11px] text-amber-300/80">
                Unsupported: {result.unsupported.slice(0, 8).join(", ")}
                {result.unsupported.length > 8 ? `, +${result.unsupported.length - 8} more` : ""}
              </div>
            )}
          </div>
        )}

        {!scan.isPending && !result && activeFilters.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-6 text-center">
            <Radio className="w-12 h-12 opacity-30" />
            <div className="text-sm">Add filters then press Run scan</div>
            <div className="text-xs opacity-60 max-w-md">
              The screener evaluates {catalog.length} indicators/patterns across the top {topN} {exchange} symbols and
              returns matching markets.
            </div>
          </div>
        )}

        {!scan.isPending && !result && activeFilters.length > 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-6 text-center">
            <Play className="w-10 h-10 opacity-30" />
            <div className="text-sm">{activeFilters.length} filter{activeFilters.length === 1 ? "" : "s"} ready</div>
            <button
              onClick={() => scan.mutate()}
              className="px-3 py-1.5 rounded text-xs bg-cyan-500/20 border border-cyan-500/40 text-cyan-200"
            >
              Run scan
            </button>
          </div>
        )}

        {scan.isPending && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-muted-foreground font-mono text-xs animate-pulse">SCANNING {exchange.toUpperCase()}…</div>
          </div>
        )}

        {result && rows.length > 0 && (
          <>
            {/* Result summary */}
            <div className="px-3 sm:px-4 py-1.5 border-b border-border text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
              <span>
                {rows.length}/{result.symbols_scanned ?? rows.length} matched
              </span>
              {result.exchange && <span>· {result.exchange}</span>}
              <span className="px-1.5 py-px rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-200">
                sort: {sortMeta.label}
              </span>
              {result.errors && result.errors.length > 0 && (
                <span className="text-amber-400">· {result.errors.length} symbol error{result.errors.length === 1 ? "" : "s"}</span>
              )}
              {result.unsupported && result.unsupported.length > 0 && (
                <span className="text-amber-400/80">· {result.unsupported.length} unsupported filter{result.unsupported.length === 1 ? "" : "s"}</span>
              )}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-white/40 border-b border-white/10">
                  <tr>
                    <th className="text-right px-2 py-2 w-10" title={`Rank by ${sortMeta.label}`}>#</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-right px-3 py-2">Last</th>
                    <th className="text-right px-3 py-2">Δ %</th>
                    <th className="text-right px-3 py-2" title={`Sort key: ${sortMeta.label}`}>{sortMeta.short}</th>
                    {valueColumns.map((c) => (
                      <th key={c} className="text-right px-3 py-2 truncate max-w-[140px]" title={c}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.symbol} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-2 py-1.5 text-right tabular-nums text-white/40">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <Link href={`/?symbol=${encodeURIComponent(r.symbol.replace("/", ""))}`}>
                          <span className="text-cyan-300 hover:text-cyan-200 cursor-pointer font-medium">
                            {r.symbol}
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-white/80">{fmtNum(r.last)}</td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          typeof r.change_pct === "number"
                            ? r.change_pct >= 0
                              ? "text-emerald-400"
                              : "text-rose-400"
                            : "text-white/40"
                        }`}
                      >
                        {typeof r.change_pct === "number" ? `${r.change_pct.toFixed(2)}%` : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-cyan-200/90" title={sortMeta.label}>
                        {fmtSortKey(r, sortMeta.value)}
                      </td>
                      {valueColumns.map((c) => (
                        <td key={c} className="px-3 py-1.5 text-right tabular-nums text-white/70">
                          {fmtNum(r.filter_results?.[c]?.actual)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-white/5">
              {rows.map((r, i) => (
                <div key={r.symbol} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] text-white/40 tabular-nums w-5 text-right">{i + 1}</span>
                      <Link href={`/?symbol=${encodeURIComponent(r.symbol.replace("/", ""))}`}>
                        <span className="text-sm text-cyan-300 font-medium">{r.symbol}</span>
                      </Link>
                    </div>
                    <span
                      className={`text-xs tabular-nums ${
                        typeof r.change_pct === "number"
                          ? r.change_pct >= 0
                            ? "text-emerald-400"
                            : "text-rose-400"
                          : "text-white/40"
                      }`}
                    >
                      {typeof r.change_pct === "number" ? `${r.change_pct.toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/60 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>last <span className="text-white/80 tabular-nums">{fmtNum(r.last)}</span></span>
                    {valueColumns.slice(0, 3).map((c) => (
                      <span key={c} className="truncate max-w-[40%]">
                        {c} <span className="text-white/80 tabular-nums">{fmtNum(r.filter_results?.[c]?.actual)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {result && rows.length === 0 && result.ok !== false && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground p-6 text-center">
            <Radio className="w-12 h-12 opacity-30" />
            <div className="text-sm">No symbols matched the active filters</div>
            <div className="text-xs opacity-60">Try loosening thresholds or adding more lenient filters.</div>
          </div>
        )}
      </div>
    </div>
  );
}
