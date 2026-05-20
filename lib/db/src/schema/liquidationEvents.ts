import {
  pgTable,
  text,
  doublePrecision,
  bigint,
  index,
} from "drizzle-orm/pg-core";

// Persistent log of executed liquidation events from supported exchange
// feeds (OKX liquidation-orders + Hyperliquid trades-as-liq). Rows are
// append-only and pruned by age via a background loop.
//
// Used by /liquidity/liquidations/clusters when callers ask for windows
// longer than the in-memory ring buffer (~30 min). For shorter windows
// the route still serves from the per-process WS caches because they're
// strictly fresher than the DB (which catches up on a 5s flush).
export const liquidationEventsTable = pgTable(
  "liquidation_events",
  {
    id: text("id").primaryKey(),
    exchange: text("exchange").notNull(), // "okx" | "hyperliquid"
    symbol: text("symbol").notNull(),
    side: text("side").notNull(), // "long" | "short"
    price: doublePrecision("price").notNull(),
    size: doublePrecision("size").notNull(),
    usdValue: doublePrecision("usd_value").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => ({
    bySymbolTs: index("liquidation_events_symbol_ts_idx").on(t.symbol, t.ts),
    byTs: index("liquidation_events_ts_idx").on(t.ts),
  }),
);

export type LiquidationEventRow = typeof liquidationEventsTable.$inferSelect;
export type InsertLiquidationEvent = typeof liquidationEventsTable.$inferInsert;
