import { sql } from "drizzle-orm";
import { db } from "./index";

// Idempotent boot-time migration. Mirrors the Drizzle schema in `./schema/`.
// Kept as `CREATE TABLE IF NOT EXISTS` so it runs unconditionally on every
// API-server start without a separate `drizzle-kit push` step in production.
//
// For dev schema changes, run `pnpm --filter @workspace/db push` to sync.
export async function ensureSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS liquidity_levels (
      id text PRIMARY KEY,
      symbol text NOT NULL,
      side text NOT NULL,
      tier integer NOT NULL,
      price double precision NOT NULL,
      strength double precision NOT NULL,
      reliability double precision NOT NULL,
      first_seen_at bigint NOT NULL,
      last_confirmed_at bigint NOT NULL,
      touches integer NOT NULL DEFAULT 0,
      methods_json text NOT NULL DEFAULT '[]'
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS liquidity_levels_symbol_idx
      ON liquidity_levels(symbol)
  `);

  // T002 — trader workflow suite.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS watchlists (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_at bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS watchlist_symbols (
      id text PRIMARY KEY,
      watchlist_id text NOT NULL,
      symbol text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      added_at bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS watchlist_symbols_watchlist_idx
      ON watchlist_symbols(watchlist_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL,
      symbol text NOT NULL,
      params_json text NOT NULL DEFAULT '{}',
      sinks_json text NOT NULL DEFAULT '["toast"]',
      throttle_ms integer NOT NULL DEFAULT 60000,
      enabled boolean NOT NULL DEFAULT true,
      created_at bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alert_history (
      id text PRIMARY KEY,
      rule_id text,
      symbol text NOT NULL,
      kind text NOT NULL,
      message text NOT NULL,
      payload_json text NOT NULL DEFAULT '{}',
      ts bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_history_ts_idx ON alert_history(ts)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_history_rule_idx ON alert_history(rule_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id text PRIMARY KEY,
      alert_id text NOT NULL,
      sink text NOT NULL,
      status text NOT NULL,
      error text,
      ts bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_deliveries_alert_idx
      ON alert_deliveries(alert_id)
  `);
  // Post-T002 addition: alert-history acknowledge (resolve) + per-symbol mutes.
  await db.execute(sql`
    ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS resolved_at bigint
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alert_mutes (
      id text PRIMARY KEY,
      symbol text NOT NULL,
      until bigint NOT NULL,
      created_at bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_mutes_symbol_idx ON alert_mutes(symbol)
  `);
  // Post-T002 round-3 addition: per-rule mute scope. Nullable; when set,
  // the engine suppresses only that one rule regardless of symbol.
  await db.execute(sql`
    ALTER TABLE alert_mutes ADD COLUMN IF NOT EXISTS rule_id text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_mutes_rule_idx ON alert_mutes(rule_id)
  `);
  // Journal feature was removed. Drop the table (and its indexes) so any
  // existing deployments converge to the same schema as fresh installs.
  // Idempotent: no-op once the table is gone.
  await db.execute(sql`DROP TABLE IF EXISTS journal_entries`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id text PRIMARY KEY,
      user_id text,
      endpoint text NOT NULL,
      keys_json text NOT NULL DEFAULT '{}',
      created_at bigint NOT NULL
    )
  `);
  await db.execute(sql`
    ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint)
  `);

  // Task #108 — persistent liquidation-event log so the clusters endpoint
  // can serve windows longer than the in-memory ring buffer (~30 min).
  // Rows are written by okx/hl liquidation feeds via a buffered flush and
  // pruned by age (default 7d retention).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS liquidation_events (
      id text PRIMARY KEY,
      exchange text NOT NULL,
      symbol text NOT NULL,
      side text NOT NULL,
      price double precision NOT NULL,
      size double precision NOT NULL,
      usd_value double precision NOT NULL,
      ts bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS liquidation_events_symbol_ts_idx
      ON liquidation_events(symbol, ts)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS liquidation_events_ts_idx
      ON liquidation_events(ts)
  `);

  // ──────────────────────────────────────────────────────────────────
  // Multi-user authentication boundary (April 2026).
  // Adds the `users` table, the `user_preferences` key-value bucket,
  // and a nullable `user_id` column on every previously single-tenant
  // user-data table (watchlists, alert_rules, alert_mutes). The route
  // layer enforces strict per-user scoping — any row with NULL user_id
  // (legacy pre-auth data) is unreachable but not deleted.
  // ──────────────────────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      last_login_at bigint
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id text NOT NULL,
      key text NOT NULL,
      value_json text NOT NULL DEFAULT 'null',
      updated_at bigint NOT NULL,
      PRIMARY KEY (user_id, key)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS user_preferences_user_idx
      ON user_preferences(user_id)
  `);

  await db.execute(sql`
    ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS user_id text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS watchlists_user_idx ON watchlists(user_id)
  `);

  await db.execute(sql`
    ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS user_id text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_rules_user_idx ON alert_rules(user_id)
  `);

  await db.execute(sql`
    ALTER TABLE alert_mutes ADD COLUMN IF NOT EXISTS user_id text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alert_mutes_user_idx ON alert_mutes(user_id)
  `);
}
