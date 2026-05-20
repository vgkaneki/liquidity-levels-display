import { useMemo, useState, useEffect } from "react";
import { Plus, X, Search } from "lucide-react";
import {
  categoryOf,
  type ActiveFilter,
  type ScreenerCatalogEntry,
  type ScreenerOperator,
} from "@/lib/screenerCatalog";

const OPERATOR_LABEL: Record<string, string> = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  "==": "=",
  "!=": "≠",
  is_true: "is true",
  is_false: "is false",
  between: "between",
  crosses_above: "crosses ↑",
  crosses_below: "crosses ↓",
  contains: "contains",
  equals: "equals",
  not_equals: "≠",
};

interface Props {
  filters: ActiveFilter[];
  onChange: (next: ActiveFilter[]) => void;
  catalog: ScreenerCatalogEntry[];
  byId: Record<string, ScreenerCatalogEntry>;
}

export function ScreenerFilterBar({ filters, onChange, catalog, byId }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const addFilter = (entry: ScreenerCatalogEntry) => {
    const f: ActiveFilter = {
      uid: `${entry.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      catalogId: entry.id,
      operator: entry.default_operator,
      value: entry.value_type === "bool" ? true : 0,
    };
    onChange([...filters, f]);
    setPickerOpen(false);
  };

  const updateFilter = (uid: string, patch: Partial<ActiveFilter>) => {
    onChange(filters.map((f) => (f.uid === uid ? { ...f, ...patch } : f)));
  };

  const removeFilter = (uid: string) => {
    onChange(filters.filter((f) => f.uid !== uid));
  };

  return (
    <div className="border-b border-border bg-card/50 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add filter
        </button>

        {filters.length === 0 && (
          <span className="text-[11px] text-muted-foreground">
            No filters — showing all live alerts. Catalog: {catalog.length} filters available.
          </span>
        )}

        {filters.map((f) => {
          const entry = byId[f.catalogId];
          if (!entry) {
            return (
              <div
                key={f.uid}
                className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-[11px]"
                title="This filter id is not in the current catalog. Remove it or refresh."
              >
                <span className="text-amber-300 font-mono truncate max-w-[180px]">{f.catalogId}</span>
                <span className="text-amber-300/60">(unknown)</span>
                <button
                  onClick={() => removeFilter(f.uid)}
                  className="ml-0.5 text-amber-300/60 hover:text-rose-400 transition-colors"
                  title="Remove filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          }
          return (
            <div
              key={f.uid}
              className="flex items-center gap-1 px-2 py-1 rounded bg-white/5 border border-white/10 text-[11px]"
            >
              <span className="text-white/80 font-medium">{entry.label}</span>
              <select
                value={f.operator}
                onChange={(e) =>
                  updateFilter(f.uid, { operator: e.target.value as ScreenerOperator })
                }
                className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/80 text-[11px] outline-none"
              >
                {entry.operators.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABEL[op] ?? op}
                  </option>
                ))}
              </select>
              {entry.value_type === "number" &&
                f.operator !== "is_true" &&
                f.operator !== "is_false" && (
                  <input
                    type="number"
                    value={String(f.value)}
                    onChange={(e) =>
                      updateFilter(f.uid, { value: parseFloat(e.target.value) || 0 })
                    }
                    className="w-16 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white text-[11px] outline-none tabular-nums"
                  />
                )}
              <button
                onClick={() => removeFilter(f.uid)}
                className="ml-0.5 text-white/40 hover:text-rose-400 transition-colors"
                title="Remove filter"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {filters.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="text-[11px] text-white/40 hover:text-white/70 ml-auto"
          >
            Clear all
          </button>
        )}
      </div>

      {pickerOpen && (
        <CatalogPicker
          catalog={catalog}
          onPick={addFilter}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function CatalogPicker({
  catalog,
  onPick,
  onClose,
}: {
  catalog: ScreenerCatalogEntry[];
  onPick: (entry: ScreenerCatalogEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("All");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((e) => set.add(categoryOf(e)));
    return ["All", ...[...set].sort()];
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => {
      if (activeCat !== "All" && categoryOf(e) !== activeCat) return false;
      if (!q) return true;
      return e.label.toLowerCase().includes(q) || e.id.includes(q);
    }).slice(0, 300);
  }, [query, activeCat, catalog]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-20"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-w-[95vw] max-h-[70vh] bg-zinc-950 border border-white/10 rounded-lg shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <Search className="w-4 h-4 text-white/40" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${catalog.length} filters (RSI, doji, volume spike, breakout...)`}
            className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-white/30"
          />
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-1 px-2 py-1.5 border-b border-white/10 overflow-x-auto">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setActiveCat(c)}
              className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap transition-colors ${
                activeCat === c
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                  : "text-white/50 hover:text-white/80 border border-transparent"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-white/40">No matches</div>
          ) : (
            filtered.map((e) => (
              <button
                key={e.id}
                onClick={() => onPick(e)}
                className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-white/5 border-b border-white/5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] uppercase font-bold text-white/40 w-20 shrink-0">
                    {categoryOf(e)}
                  </span>
                  <span className="text-sm text-white truncate">{e.label}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-white/40 shrink-0">
                  {e.timeframe && (
                    <span className="px-1.5 py-0.5 bg-white/5 rounded">{e.timeframe}</span>
                  )}
                  <span>{e.value_type}</span>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="px-3 py-2 border-t border-white/10 text-[10px] text-white/40 flex justify-between">
          <span>
            Showing {filtered.length} of {catalog.length} filters
          </span>
          <span>↵ click to add · esc to close</span>
        </div>
      </div>
    </div>
  );
}
