import type { SymbolAdapter, SymbolAdapterRecord } from "../types";
import { fetchInstruments } from "../../../routes/liquidity/exchanges/toobit";

export const toobitAdapter: SymbolAdapter = {
  exchange: "toobit",
  ttlMs: 60 * 60_000,
  async fetch(): Promise<SymbolAdapterRecord[]> {
    const list = await fetchInstruments();
    if (!list) throw new Error("toobit fetchInstruments returned null");
    return list.map((i) => ({
      ui: i.uiSymbol,
      base: i.baseAsset,
      quote: "USDT",
      native: i.symbol,
    }));
  },
};
