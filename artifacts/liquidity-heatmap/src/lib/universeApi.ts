import { canonicalizeUiSymbol, toDisplayUsdtSymbol } from "@/datafeed/normalize";
import { apiUrl } from "@/lib/api";

export type ExchangeTag = "okx" | "hyperliquid" | "toobit";

export interface UniverseRow {
  symbol: string;        // canonical, e.g. "BTCUSDT"
  base: string;          // e.g. "BTC"
  exchanges: ExchangeTag[];
  volume24h: number;
}

export interface SymbolItem {
  symbol: string;        // display form, e.g. "BTC-USDT"
  base: string;
  tier: number;          // 1..4 from volume bucket
  exchanges: ExchangeTag[];
}

export const FALLBACK_SYMBOLS: SymbolItem[] = [
  { symbol: "BTC-USDT", base: "BTC", tier: 1, exchanges: ["okx", "hyperliquid"] },
  { symbol: "ETH-USDT", base: "ETH", tier: 1, exchanges: ["okx", "hyperliquid"] },
  { symbol: "SOL-USDT", base: "SOL", tier: 1, exchanges: ["okx", "hyperliquid"] },
  { symbol: "BNB-USDT", base: "BNB", tier: 1, exchanges: ["okx"] },
  { symbol: "XRP-USDT", base: "XRP", tier: 1, exchanges: ["okx", "hyperliquid"] },
  { symbol: "DOGE-USDT", base: "DOGE", tier: 1, exchanges: ["okx", "hyperliquid"] },
];

function bucketTier(index: number, total: number): number {
  if (total <= 0) return 4;
  const pct = index / total;
  if (pct < 0.05) return 1;
  if (pct < 0.30) return 2;
  if (pct < 0.80) return 3;
  return 4;
}

export function rowsToItems(rows: UniverseRow[]): SymbolItem[] {
  return rows.map((r, i) => ({
    symbol: toDisplayUsdtSymbol(r.symbol || `${r.base}USDT`),
    base: r.base || canonicalizeUiSymbol(r.symbol).replace(/USDT$/, ""),
    tier: bucketTier(i, rows.length),
    exchanges: r.exchanges,
  }));
}

export async function fetchUniverseRows(): Promise<UniverseRow[]> {
  try {
    const res = await fetch(apiUrl(`/api/liquidity/universe`), {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { symbols?: UniverseRow[] };
    return Array.isArray(body.symbols) ? body.symbols : [];
  } catch {
    return [];
  }
}

export async function fetchUniverseItems(): Promise<SymbolItem[]> {
  const rows = await fetchUniverseRows();
  return rows.length > 0 ? rowsToItems(rows) : FALLBACK_SYMBOLS;
}

export function topAndMajor(rows: UniverseRow[]): string[] {
  const cutoff = Math.max(1, Math.ceil(rows.length * 0.30));
  return rows.slice(0, cutoff).map((r) => toDisplayUsdtSymbol(r.symbol || `${r.base}USDT`));
}
