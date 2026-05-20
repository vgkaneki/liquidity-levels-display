import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  hashPassword,
  verifyPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../auth/passwordHash";
import {
  loginRateLimiter,
  registerRateLimiter,
} from "../auth/rateLimits";
import { ensureUserDefaultWatchlist } from "../services/watchlistSeed";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Email format: deliberately permissive — RFC 5322 is too restrictive
// for real-world addresses and we don't deliver mail (no MFA / reset
// flows yet). We require a `@` with at least one char on each side and
// no whitespace, then enforce uniqueness at the DB layer.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC-5321

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function validatePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < MIN_PASSWORD_LENGTH) return null;
  if (raw.length > MAX_PASSWORD_LENGTH) return null;
  return raw;
}

function userPayload(u: { id: string; email: string; createdAt: number }) {
  return { id: u.id, email: u.email, createdAt: u.createdAt };
}

// Regenerate the express-session id on auth state change to defeat
// session fixation. Wraps the callback API in a promise.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

router.post("/auth/register", registerRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = validatePassword(req.body?.password);
    if (!email) {
      res.status(400).json({ error: "Valid email required." });
      return;
    }
    if (!password) {
      res.status(400).json({
        error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      });
      return;
    }

    // Uniqueness pre-check (the unique index is the real authority — we
    // catch its 23505 below in case of a race). The pre-check produces
    // a friendlier 409 in the common case.
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }

    const hash = await hashPassword(password);
    const now = Date.now();
    const id = randomUUID();
    try {
      await db.insert(usersTable).values({
        id,
        email,
        passwordHash: hash,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "23505") {
        res.status(409).json({ error: "An account with that email already exists." });
        return;
      }
      throw err;
    }

    // Seed the user's default watchlist so the first login lands on a
    // populated panel rather than an empty list. Non-fatal if it fails.
    try {
      await ensureUserDefaultWatchlist(id);
    } catch (e) {
      logger.warn({ err: e, userId: id }, "auth/register: default watchlist seed failed");
    }

    // Establish the session for the freshly-registered user.
    await regenerateSession(req);
    req.session.userId = id;
    req.session.userEmail = email;
    res.json({ user: userPayload({ id, email, createdAt: now }) });
  } catch (err) {
    logger.error({ err }, "auth/register failed");
    res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/auth/login", loginRateLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      // Same generic error for "bad email format" and "wrong password" —
      // never reveal whether the email exists.
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    const user = rows[0];

    // Time-equalize the no-such-user path with the wrong-password path
    // by always running the bcrypt comparison. We compare against a
    // dummy hash if the account doesn't exist so the response time
    // doesn't leak account existence.
    const hash = user?.passwordHash ?? "$2b$10$invalidsaltinvalidsaltinvOe6kTxL5wJxiZ5K9V0Lyk7xVO7Zc8a";
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const now = Date.now();
    await db
      .update(usersTable)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(usersTable.id, user.id));

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.json({ user: userPayload(user) });
  } catch (err) {
    logger.error({ err }, "auth/login failed");
    res.status(500).json({ error: "Login failed." });
  }
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    // Tell the browser to drop the session cookie. The cookie name
    // matches express-session's default ("connect.sid"); if we ever
    // customize sessionMiddleware's cookie.name, update here too.
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.get("/auth/me", async (req, res) => {
  const uid = req.session?.userId;
  if (!uid) {
    res.json({ user: null });
    return;
  }
  const rows = await db
    .select({ id: usersTable.id, email: usersTable.email, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.id, uid))
    .limit(1);
  const user = rows[0];
  if (!user) {
    // Session points to a deleted account — destroy the stale session
    // so the client lands on /login cleanly.
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ user: null });
    });
    return;
  }
  res.json({ user: userPayload(user) });
});

// Backwards-compat shim. The pre-multi-user code shipped a
// /api/auth/check endpoint that reported `{ authenticated: bool }`.
// Some legacy frontend callers may still hit it on first paint; we
// preserve the shape so they don't 404 during the rollover window.
router.get("/auth/check", (req, res) => {
  res.json({ authenticated: !!req.session?.userId });
});

export default router;
