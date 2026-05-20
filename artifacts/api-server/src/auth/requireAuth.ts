import type { Request, Response, NextFunction } from "express";

// Extend the express-session type so `req.session.userId` is typed
// throughout the codebase without per-file `as any` casts.
declare module "express-session" {
  interface SessionData {
    userId?: string;
    userEmail?: string;
  }
}

/**
 * Boundary middleware. Rejects any request without an authenticated
 * session with 401. Mounted on the /api router AFTER the public auth +
 * health endpoints are registered.
 *
 * The session itself is established by /api/auth/login, which writes
 * `req.session.userId` (the canonical user id, used for all per-user
 * scoping by every downstream route handler).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uid = req.session?.userId;
  if (!uid || typeof uid !== "string") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Helper for handlers: pull the authenticated user id out of the
 * session in a typed, runtime-checked way. Throws if called without
 * `requireAuth` having already gated the request — callers should
 * always be downstream of the middleware.
 */
export function getUserId(req: Request): string {
  const uid = req.session?.userId;
  if (!uid || typeof uid !== "string") {
    // Defense-in-depth: a route handler should never be reachable
    // without requireAuth running first, so this is a programmer
    // error rather than a user-input error.
    throw new Error("getUserId called on an unauthenticated request");
  }
  return uid;
}
