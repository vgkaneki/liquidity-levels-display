import type { SymbolAdapter, SymbolAdapterRecord } from "../types";
import { fetchAllAssets } from "../../../routes/liquidity/exchanges/hyperliquid";

export const hlAdapter: SymbolAdapter = {
  exchange: "hl",
  ttlMs: 60_000,
  async fetch(): Promise<SymbolAdapterRecord[]> {
    const map = await fetchAllAssets();
    if (!map) throw new Error("hl fetchAllAssets returned null");
    const out: SymbolAdapterRecord[] = [];
    for (const coin of map.keys()) {
      const base = coin.toUpperCase();
      out.push({
        ui: `${base}USDT`,
        base,
        quote: "USDT",
        native: coin,
      });
    }
    return out;
  },
};
