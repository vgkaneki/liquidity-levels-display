import type { SymbolAdapter, SymbolAdapterRecord } from "../types";
import { fetchInstruments } from "../../../routes/liquidity/exchanges/okx";

export const okxAdapter: SymbolAdapter = {
  exchange: "okx",
  ttlMs: 5 * 60_000,
  async fetch(): Promise<SymbolAdapterRecord[]> {
    const list = await fetchInstruments();
    if (!list) throw new Error("okx fetchInstruments returned null");
    return list.map((i) => ({
      ui: i.symbol,
      base: i.baseAsset,
      quote: i.quoteAsset,
      native: i.instId,
    }));
  },
};
