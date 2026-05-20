import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// dbPoolConfigV1: explicit pool limits prevent connection exhaustion on
// Render's free Postgres tier (max 25 connections shared across all clients).
// connectionTimeoutMillis prevents a request from hanging forever when all
// pool slots are busy. statement_timeout kills runaway queries before they
// cascade into full connection starvation.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? "10"),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? "5000"),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "30000"),
});

pool.on("error", (err) => {
  // Log unexpected idle-client errors without crashing the process.
  // The next query will pull a fresh connection from the pool.
  console.error("[db-pool] idle client error", err.message);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export { ensureSchema } from "./migrate";
