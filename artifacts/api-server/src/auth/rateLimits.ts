import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

// Brute-force defense for the auth surface. Limits are deliberately
// generous enough that a fat-fingered legitimate user is never locked
// out, but tight enough that an automated credential-stuffing run
// against a known email is reduced to ~1 attempt every 10 seconds.
// Both limiters key on IP only; we layer per-account lockout in the
// route handler if we ever see organic abuse beyond what the IP-keyed
// limiter catches.

export const loginRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in a minute." },
  // Only failed logins count toward the limit. A user successfully
  // signing in/out repeatedly (e.g. switching browsers) shouldn't get
  // throttled — only credential-stuffing patterns should.
  skipSuccessfulRequests: true,
  // Skip rate-limiting in test runs to keep the test suite hermetic.
  skip: () => process.env.NODE_ENV === "test",
});

export const registerRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  // 20/hr is generous enough that a small team / household behind a
  // single NAT can all sign up in one sitting, but still tight enough
  // that an automated bot can't dump 1000 accounts/day from one IP.
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Try again later." },
  // Validation-failure responses (400) don't count — only successful
  // creations and 5xx do, so a user typo-correcting their email isn't
  // penalized.
  skipFailedRequests: true,
  skip: () => process.env.NODE_ENV === "test",
});
