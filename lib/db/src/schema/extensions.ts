import {
  pgTable,
  text,
  doublePrecision,
  integer,
  bigint,
  boolean,
  index,
} from "drizzle-orm/pg-core";

// T002 — trader workflow suite. Originally single-installation; now
// scoped per-user via the nullable `user_id` column (multi-user auth
// boundary). The route layer enforces strict scoping; legacy rows
// with NULL user_id (from pre-auth installs) become unreachable.

export const watchlistsTable = pgTable(
  "watchlists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    byUser: index("watchlists_user_idx").on(t.userId),
  }),
);

export const watchlistSymbolsTable = pgTable(
  "watchlist_symbols",
  {
    id: text("id").primaryKey(),
    watchlistId: text("watchlist_id").notNull(),
    symbol: text("symbol").notNull(),
    position: integer("position").notNull().default(0),
    addedAt: bigint("added_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    byWatchlist: index("watchlist_symbols_watchlist_idx").on(t.watchlistId),
  }),
);

export const alertRulesTable = pgTable(
  "alert_rules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // price_above | price_below | level_touch | tier_change
    symbol: text("symbol").notNull(), // canonical e.g. BTCUSDT or "*"
    userId: text("user_id"),
    paramsJson: text("params_json").notNull().default("{}"),
    sinksJson: text("sinks_json").notNull().default("[\"toast\"]"),
    throttleMs: integer("throttle_ms").notNull().default(60000),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    byUser: index("alert_rules_user_idx").on(t.userId),
  }),
);

export const alertHistoryTable = pgTable(
  "alert_history",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id"),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    ts: bigint("ts", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
  },
  (t) => ({
    byTs: index("alert_history_ts_idx").on(t.ts),
    byRule: index("alert_history_rule_idx").on(t.ruleId),
  }),
);

// Per-symbol (or wildcard) mutes. While `until > now`, the alert engine
// suppresses dispatch for matching rules without consuming throttle or
// marking state as fired. Used by the "mute for 1h" button on the
// alerts page.
export const alertMutesTable = pgTable(
  "alert_mutes",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(), // canonical or "*"
    // Optional per-rule scope. When set, the mute suppresses only that
    // one rule (regardless of symbol). Leave null for a symbol-scoped
    // mute that applies to every rule matching `symbol`.
    ruleId: text("rule_id"),
    userId: text("user_id"),
    until: bigint("until", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    bySymbol: index("alert_mutes_symbol_idx").on(t.symbol),
    byRule: index("alert_mutes_rule_idx").on(t.ruleId),
    byUser: index("alert_mutes_user_idx").on(t.userId),
  }),
);

export const alertDeliveriesTable = pgTable(
  "alert_deliveries",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id").notNull(),
    sink: text("sink").notNull(),
    status: text("status").notNull(), // ok | error
    error: text("error"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => ({
    byAlert: index("alert_deliveries_alert_idx").on(t.alertId),
  }),
);

export const pushSubscriptionsTable = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    endpoint: text("endpoint").notNull(),
    keysJson: text("keys_json").notNull().default("{}"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    byUser: index("push_subscriptions_user_idx").on(t.userId),
    byEndpoint: index("push_subscriptions_endpoint_idx").on(t.endpoint),
  }),
);
