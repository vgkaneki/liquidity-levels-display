import express, { type Express, type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import session from "express-session";
import cors from "cors";
import compression from "compression";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import authRouter from "./routes/auth";
import { logger } from "./lib/logger";
import { createSessionStore } from "./lib/pgSessionStore";
import { requireAuth } from "./auth/requireAuth";

const app: Express = express();

// securityOpsHardeningV1: baseline HTTP hardening for production deploys.
// This is transport/runtime protection only and does not affect engine logic.
app.disable("x-powered-by");

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self' https: wss: ws:",
    ].join("; "),
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
};

app.use(securityHeaders);

app.use((req, res, next) => {
  const inbound = req.headers["x-request-id"];
  const clean = typeof inbound === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(inbound)
    ? inbound
    : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  res.setHeader("X-Request-Id", clean);
  (req as { requestId?: string }).requestId = clean;
  next();
});

app.use(compression());

// fastStaticShellV1: serve the app shell and hashed frontend assets after
// compression but before request logging, sessions, auth, JSON parsing, and API
// routing. This keeps JS/CSS compressed while avoiding session/log middleware
// overhead for page assets. Hosting glue only; no engine logic.
const earlyStaticDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(process.cwd(), "artifacts/liquidity-heatmap/dist/public");

if (fs.existsSync(earlyStaticDir)) {
  app.use(
    express.static(earlyStaticDir, {
      index: false,
      maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
      immutable: process.env.NODE_ENV === "production",
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        }
      },
    }),
  );

  app.get(/.*/, (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(earlyStaticDir, "index.html"));
  });
}

app.use(
  pinoHttp({
    logger,
    // loadingPerformanceV1: do not spend server CPU logging every hashed JS/CSS
    // asset request or health probe. API and websocket route logs remain intact.
    autoLogging: {
      ignore: (req) => {
        const url = req.url || "";
        return (
          req.method === "GET" &&
          (url.startsWith("/assets/") ||
            url === "/favicon.ico" ||
            url === "/manifest.webmanifest" ||
            url === "/robots.txt" ||
            url === "/api/healthz" ||
            url === "/api/status")
        );
      },
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS — production gets a strict allowlist from `ALLOWED_ORIGINS`
// (comma-separated), dev reflects the request origin so the Vite
// preview iframe + the workspace proxy domain both work without
// extra config. Credentials are required for the session cookie.
const allowedOriginsRaw = [
  process.env.ALLOWED_ORIGINS ?? "",
  process.env.PUBLIC_APP_URL ?? "",
  process.env.RENDER_EXTERNAL_URL ?? "",
]
  .join(",")
  .trim();
const allowedOrigins = Array.from(
  new Set(
    allowedOriginsRaw
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ),
);

app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      // No origin header (curl, server-to-server, same-origin XHR) —
      // always allow; the SameSite=Lax cookie is the actual CSRF gate.
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== "production") return cb(null, true);
      if (allowedOrigins.length === 0) {
        // Production with no explicit list — fail closed: refuse the
        // cookie-bearing cross-origin request rather than silently
        // permitting it. The deployment must set ALLOWED_ORIGINS.
        return cb(null, false);
      }
      if (allowedOrigins.includes(origin)) return cb(null, origin);
      return cb(null, false);
    },
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function headerOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function sameRequestOrigin(req: Request): string | null {
  const host = req.headers.host;
  if (typeof host !== "string" || !host) return null;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string"
    ? forwardedProto.split(",")[0]?.trim() || req.protocol
    : req.protocol;
  return proto + "://" + host;
}

function isTrustedStateChangeOrigin(req: Request, origin: string | null): boolean {
  if (!origin) return true;
  const sameOrigin = sameRequestOrigin(req);
  return origin === sameOrigin || allowedOrigins.includes(origin);
}

const csrfOriginGuard: RequestHandler = (req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();
  if (!req.path.startsWith("/api/")) return next();
  if (!stateChangingMethods.has(req.method)) return next();
  const origin = headerOrigin(req.headers.origin) ?? headerOrigin(req.headers.referer);
  if (isTrustedStateChangeOrigin(req, origin)) return next();
  res.status(403).json({ error: "Forbidden.", requestId: res.getHeader("X-Request-Id") });
};

const apiRateLimiter = rateLimit({
  windowMs: boundedIntEnv("API_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 15 * 60_000),
  limit: boundedIntEnv("API_RATE_LIMIT_MAX", 900, 60, 100_000),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/healthz" || req.path === "/readyz" || req.path === "/status",
  message: { error: "Too many requests." },
});

app.use(csrfOriginGuard);
app.use("/api", apiRateLimiter);

app.set("trust proxy", 1);

// Boot-time invariant: in production we MUST have a real session
// secret. Refusing to boot here is intentional — running on the dev
// fallback in production would let an attacker forge `connect.sid`
// cookies and impersonate any user.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET must be set in production. Refusing to boot with the dev fallback secret.",
  );
}

// Exported so the WS hub can reuse the same middleware to validate
// `req.session.userId` on upgrade requests, instead of trusting the
// presence of a `connect.sid` cookie (which is trivially forgeable).
// pgSessionStoreV1 replaces express-session's default MemoryStore in
// production. Set ENABLE_MEMORY_SESSION_STORE=1 only for emergency rollback.
export const sessionMiddleware = session({
  store: createSessionStore(),
  secret: process.env.SESSION_SECRET || "dev-fallback-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
  },
});

app.use(sessionMiddleware);

app.get("/api/status", (_req, res) => {
  res.status(200).send("Axion API server is running");
});

// ─────────────────────────────────────────────────────────────────
// Public boundary. Routes mounted here do NOT require an
// authenticated session. Everything else under /api goes through
// the requireAuth gate below.
// ─────────────────────────────────────────────────────────────────
app.use("/api", authRouter);

app.get("/api/healthz", (_req, res) => {
  // Mirror of routes/health.ts /healthz — kept here as a public probe
  // so a load balancer can ping the server without an auth context.
  res.json({ ok: true, t: Date.now() });
});

app.get("/api/readyz", (_req, res) => {
  // Lightweight readiness surface for load balancers and uptime probes.
  // Avoids leaking DB credentials, symbols, caches, or engine internals.
  res.json({ ok: true, uptimeMs: Math.round(process.uptime() * 1000), t: Date.now() });
});

// Protected boundary. Every /api/* route below this line REQUIRES a
// valid session userId (set by /api/auth/login or /api/auth/register).
app.use("/api", requireAuth);
app.use("/api", router);

const apiErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : err instanceof SyntaxError && "body" in err
          ? 400
          : 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message =
    safeStatus === 400
      ? "Invalid request payload."
      : safeStatus === 401
        ? "Unauthorized."
        : safeStatus === 403
          ? "Forbidden."
          : safeStatus === 404
            ? "Not found."
            : "Internal server error.";

  if (safeStatus >= 500) {
    logger.error({ err, path: req.path, method: req.method }, "api request failed");
  } else {
    logger.warn({ err, path: req.path, method: req.method }, "api request rejected");
  }

  if (res.headersSent) return;
  res.status(safeStatus).json({ error: message, requestId: res.getHeader("X-Request-Id") });
};

// ─────────────────────────────────────────────────────────────────
// Production web bundle serving for one-service Render deployment.
// This is UI/hosting glue only: it does not touch liquidity formulas,
// confluence scoring, DOM/Bookmap logic, absorption logic, or level math.
//
// Render deploys this as a single free Web Service so same-origin
// /api and /ws calls keep working without a separate reverse proxy.
// ─────────────────────────────────────────────────────────────────
const staticDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(process.cwd(), "artifacts/liquidity-heatmap/dist/public");

if (fs.existsSync(staticDir)) {
  app.use(
    express.static(staticDir, {
      index: false,
      // assetCacheV1: hashed Vite assets can be cached aggressively. This
      // reduces repeat-load time and removes avoidable API-server work.
      maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
      immutable: process.env.NODE_ENV === "production",
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, max-age=0");
        }
      },
    }),
  );

  app.get(/.*/, (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
      next();
      return;
    }

    // indexNoStoreV1: always revalidate the app shell so deploys update cleanly
    // while hashed assets stay cached for fast repeat loads.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  next();
});

app.use(apiErrorHandler);

export default app;
