export type ExchangeId = "hl" | "okx" | "toobit";

export type DataType =
  | "candles"
  | "book"
  | "ticker"
  | "funding"
  | "oi"
  | "liquidations"
  | "trades";

export type Listing = "yes" | "no" | "unknown";

export interface SymbolMeta {
  ui: string;
  base: string;
  quote: string;
  native: Partial<Record<ExchangeId, string>>;
  listed: Record<ExchangeId, Listing>;
}

export interface SymbolAdapterRecord {
  ui: string;
  base: string;
  quote: string;
  native: string;
}

export interface SymbolAdapter {
  exchange: ExchangeId;
  ttlMs: number;
  fetch(): Promise<SymbolAdapterRecord[]>;
}

export interface AdapterSnapshot {
  exchange: ExchangeId;
  records: SymbolAdapterRecord[];
  fetchedAt: number;
  ok: boolean;
}

export const ALL_EXCHANGES: ExchangeId[] = ["hl", "okx", "toobit"];
