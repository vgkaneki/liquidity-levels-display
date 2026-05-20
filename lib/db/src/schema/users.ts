import {
  pgTable,
  text,
  bigint,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// Real multi-user accounts. Sessions in express-session reference
// `users.id`; every user-scoped table (watchlists, alert_rules,
// alert_mutes, user_preferences) joins back to this row by `user_id`.
//
// Email is stored lowercase + trimmed by the application layer; the
// DB enforces uniqueness via a btree unique index. We do NOT store the
// raw password — only the bcrypt hash.
export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastLoginAt: bigint("last_login_at", { mode: "number" }),
  },
  (t) => ({
    byEmail: index("users_email_idx").on(t.email),
  }),
);

// Per-user UI preferences. Single key/value store keyed on
// (userId, key) so the frontend can roam any persisted setting
// across devices without a schema change per setting type.
//
// Value is JSONB-friendly; we store as text and let the app layer
// JSON.parse/stringify so the schema is portable across pg drivers
// without depending on a specific JSON column codec.
export const userPreferencesTable = pgTable(
  "user_preferences",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull().default("null"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.key] }),
    byUser: index("user_preferences_user_idx").on(t.userId),
  }),
);
