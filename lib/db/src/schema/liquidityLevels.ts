import {
  pgTable,
  text,
  doublePrecision,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Persistent level registry. Single-installation scope — no user keying.
// Rows mirror the in-memory registry one-to-one and exist purely so
// discovered levels survive an API-server restart.
export const liquidityLevelsTable = pgTable(
  "liquidity_levels",
  {
    id: text("id").primaryKey(), // `${symbol}:${side}:${quantizedPrice}`
    symbol: text("symbol").notNull(),
    side: text("side").notNull(), // "support" | "resistance" | "neutral"
    tier: integer("tier").notNull(), // 0..3 (3 = elite)
    price: doublePrecision("price").notNull(),
    strength: doublePrecision("strength").notNull(), // EMA-smoothed 0..1
    reliability: doublePrecision("reliability").notNull(), // posterior bounce-rate
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastConfirmedAt: bigint("last_confirmed_at", { mode: "number" }).notNull(),
    touches: integer("touches").notNull().default(0),
    methodsJson: text("methods_json").notNull().default("[]"),
  },
  (t) => ({
    bySymbol: index("liquidity_levels_symbol_idx").on(t.symbol),
    byKey: uniqueIndex("liquidity_levels_pk_idx").on(t.id),
  }),
);

export const insertLiquidityLevelSchema = createInsertSchema(
  liquidityLevelsTable,
);
export type LiquidityLevelRow = typeof liquidityLevelsTable.$inferSelect;
export type InsertLiquidityLevel = z.infer<typeof insertLiquidityLevelSchema>;
