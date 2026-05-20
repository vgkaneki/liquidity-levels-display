import catalogJson from "@/data/screenerCatalog.json";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";

export type ScreenerOperator = string;

export const KNOWN_OPERATORS = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
  "is_true",
  "is_false",
  "between",
  "crosses_above",
  "crosses_below",
  "contains",
  "equals",
  "not_equals",
] as const;

export type ScreenerValueType = "number" | "bool" | "string";

export interface ScreenerCatalogEntry {
  id: string;
  label: string;
  kind: string;
  supported: boolean;
  value_type: ScreenerValueType;
  operators: ScreenerOperator[];
  default_operator: ScreenerOperator;
  timeframe: string | null;
  definition: {
    family: string;
    [key: string]: unknown;
  };
}

export interface ActiveFilter {
  uid: string;
  catalogId: string;
  operator: ScreenerOperator;
  value: number | boolean | string;
  value2?: number;
}

export const SCREENER_CATALOG = catalogJson as ScreenerCatalogEntry[];

export const CATALOG_BY_ID: Record<string, ScreenerCatalogEntry> = Object.fromEntries(
  SCREENER_CATALOG.map((e) => [e.id, e]),
);

export function categoryOf(entry: ScreenerCatalogEntry): string {
  const fam = entry.definition.family;
  if (fam === "indicator_value") return "Indicator";
  if (fam === "pattern_event") return "Pattern";
  if (fam === "metric") return "Metric";
  if (fam === "relative_volume") return "Volume";
  if (fam === "range_bars") return "Range";
  if (fam === "crossover") return "Crossover";
  if (fam === "support_resistance") return "S/R";
  if (fam === "chart_pattern") return "Chart Pattern";
  if (fam === "candle") return "Candle";
  return fam.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const STORAGE_KEY = "thermal.scanner.activeFilters.v1";

export function loadActiveFilters(): ActiveFilter[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveActiveFilters(filters: ActiveFilter[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

interface ScreenerCatalogResponse {
  total: number;
  supported_total: number;
  items: ScreenerCatalogEntry[];
}

async function fetchScreenerCatalog(): Promise<ScreenerCatalogEntry[]> {
  const res = await fetch(apiUrl(`/api/screener/catalog?supported_only=1`), { credentials: "include" });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const data = (await res.json()) as ScreenerCatalogResponse;
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Live screener catalog hook. Returns the server-side catalog when reachable,
 * otherwise falls back to the bundled local catalog so the filter UI never
 * blanks. Safe to call from any component under the QueryClient provider.
 */
export function useScreenerCatalog(): {
  catalog: ScreenerCatalogEntry[];
  byId: Record<string, ScreenerCatalogEntry>;
  loading: boolean;
  source: "live" | "bundled";
} {
  const { data, isLoading } = useQuery<ScreenerCatalogEntry[]>({
    queryKey: ["/api/screener/catalog"],
    queryFn: fetchScreenerCatalog,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const live = data && data.length > 0 ? data : null;
  const catalog = live ?? SCREENER_CATALOG;
  const byId = live
    ? Object.fromEntries(live.map((e) => [e.id, e]))
    : CATALOG_BY_ID;
  return { catalog, byId, loading: isLoading, source: live ? "live" : "bundled" };
}
