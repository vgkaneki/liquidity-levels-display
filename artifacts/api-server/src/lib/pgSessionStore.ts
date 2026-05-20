import session, { type SessionData } from "express-session";

// pgSessionStoreV1
// Production-safe express-session store backed by the existing @workspace/db pool.
// This replaces express-session's default MemoryStore in production without adding
// new runtime dependencies or touching trading-engine logic.
const SESSION_TABLE = "app_sessions";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let tableReady: Promise<void> | null = null;
let poolPromise: Promise<any> | null = null;

function shouldUsePgStore(): boolean {
  return process.env.NODE_ENV === "production" && process.env.ENABLE_MEMORY_SESSION_STORE !== "1";
}

async function getPool(): Promise<any> {
  poolPromise ??= import("@workspace/db").then((mod) => mod.pool);
  return poolPromise;
}

async function ensureSessionTable(): Promise<void> {
  if (!shouldUsePgStore()) return;
  tableReady ??= (async () => {
    const pool = await getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
        sid text PRIMARY KEY,
        sess jsonb NOT NULL,
        expire timestamptz NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${SESSION_TABLE}_expire_idx
      ON ${SESSION_TABLE} (expire)
    `);
  })();
  await tableReady;
}

function getExpiry(sess: SessionData): Date {
  const rawExpires = sess.cookie?.expires;
  if (rawExpires instanceof Date) return rawExpires;
  if (typeof rawExpires === "string") {
    const parsed = new Date(rawExpires);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const maxAge = typeof sess.cookie?.maxAge === "number" ? sess.cookie.maxAge : DEFAULT_TTL_MS;
  return new Date(Date.now() + maxAge);
}

export class PgSessionStore extends session.Store {
  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    void (async () => {
      await ensureSessionTable();
      const pool = await getPool();
      const result = await pool.query(
        `SELECT sess FROM ${SESSION_TABLE} WHERE sid = $1 AND expire > now() LIMIT 1`,
        [sid],
      );
      callback(null, result.rows[0]?.sess ?? null);
    })().catch((err) => callback(err));
  }

  set(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    void (async () => {
      await ensureSessionTable();
      const pool = await getPool();
      await pool.query(
        `INSERT INTO ${SESSION_TABLE} (sid, sess, expire)
         VALUES ($1, $2, $3)
         ON CONFLICT (sid)
         DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, sess, getExpiry(sess)],
      );
      callback?.();
    })().catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void (async () => {
      await ensureSessionTable();
      const pool = await getPool();
      await pool.query(`DELETE FROM ${SESSION_TABLE} WHERE sid = $1`, [sid]);
      callback?.();
    })().catch((err) => callback?.(err));
  }

  touch(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    void (async () => {
      await ensureSessionTable();
      const pool = await getPool();
      await pool.query(`UPDATE ${SESSION_TABLE} SET expire = $2 WHERE sid = $1`, [
        sid,
        getExpiry(sess),
      ]);
      callback?.();
    })().catch((err) => callback?.(err));
  }
}

export function createSessionStore(): session.Store | undefined {
  if (!shouldUsePgStore()) return undefined;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set in production when using the PostgreSQL session store.",
    );
  }
  return new PgSessionStore();
}
