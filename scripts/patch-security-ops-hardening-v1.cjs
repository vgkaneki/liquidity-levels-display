const fs = require('fs');

function patchFile(file, marker, label, mutator) {
  let body = fs.readFileSync(file, 'utf8');
  if (body.includes(marker)) {
    console.log(`[security-ops-hardening-v1] already applied ${label}`);
    return;
  }
  const next = mutator(body);
  if (next === body) {
    console.log(`[security-ops-hardening-v1] skipped ${label}`);
    return;
  }
  fs.writeFileSync(file, next);
  console.log(`[security-ops-hardening-v1] applied ${label}`);
}

function replaceOnce(body, find, replace, label) {
  if (!body.includes(find)) {
    console.log(`[security-ops-hardening-v1] skipped ${label}`);
    return body;
  }
  return body.replace(find, replace);
}

// securityOpsHardeningV1:
// Display/runtime/transport/ops hardening only. Protected liquidity/structural
// formulas, confluence/scoring, touch classification, DOM/Bookmap, absorption,
// and level placement math are intentionally untouched.

patchFile(
  'artifacts/api-server/src/app.ts',
  'securityOpsHardeningV1',
  'api security middleware',
  (body) => {
    let out = body;
    out = replaceOnce(
      out,
      'import express, { type Express, type ErrorRequestHandler } from "express";',
      'import express, { type Express, type ErrorRequestHandler, type Request, type RequestHandler } from "express";',
      'express Request and RequestHandler import',
    );
    out = replaceOnce(
      out,
      'import compression from "compression";\n',
      'import compression from "compression";\nimport { rateLimit } from "express-rate-limit";\n',
      'rate limit import',
    );
    out = replaceOnce(
      out,
      'const app: Express = express();\n\napp.use(compression());',
      `const app: Express = express();

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
    : \`req-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 10)}\`;
  res.setHeader("X-Request-Id", clean);
  (req as { requestId?: string }).requestId = clean;
  next();
});

app.use(compression());`,
      'security headers and request id',
    );
    out = replaceOnce(
      out,
      'app.use(express.json({ limit: "256kb" }));\napp.use(express.urlencoded({ extended: true, limit: "256kb" }));\n\napp.set("trust proxy", 1);',
      `app.use(express.json({ limit: "256kb" }));
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

app.set("trust proxy", 1);`,
      'csrf origin guard and api rate limiter',
    );
    out = replaceOnce(
      out,
      'app.get("/api/healthz", (_req, res) => {\n  // Mirror of routes/health.ts /healthz — kept here as a public probe\n  // so a load balancer can ping the server without an auth context.\n  res.json({ ok: true, t: Date.now() });\n});',
      `app.get("/api/healthz", (_req, res) => {
  // Mirror of routes/health.ts /healthz — kept here as a public probe
  // so a load balancer can ping the server without an auth context.
  res.json({ ok: true, t: Date.now() });
});

app.get("/api/readyz", (_req, res) => {
  // Lightweight readiness surface for load balancers and uptime probes.
  // Avoids leaking DB credentials, symbols, caches, or engine internals.
  res.json({ ok: true, uptimeMs: Math.round(process.uptime() * 1000), t: Date.now() });
});`,
      'readyz endpoint',
    );
    out = replaceOnce(
      out,
      'res.status(safeStatus).json({ error: message });',
      'res.status(safeStatus).json({ error: message, requestId: res.getHeader("X-Request-Id") });',
      'error envelope request id',
    );
    return out;
  },
);

patchFile(
  'artifacts/api-server/src/index.ts',
  'serverLifecycleHardeningV1',
  'server timeouts and graceful shutdown',
  (body) => {
    let out = body;
    out = replaceOnce(
      out,
      'const httpServer = createServer(app);\n',
      `const httpServer = createServer(app);

// serverLifecycleHardeningV1: explicit network timeouts and graceful shutdown
// for production runtime safety. Transport/process lifecycle only.
function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

httpServer.requestTimeout = boundedIntEnv("SERVER_REQUEST_TIMEOUT_MS", 30_000, 5_000, 120_000);
httpServer.headersTimeout = boundedIntEnv("SERVER_HEADERS_TIMEOUT_MS", 35_000, 5_000, 125_000);
httpServer.keepAliveTimeout = boundedIntEnv("SERVER_KEEPALIVE_TIMEOUT_MS", 5_000, 1_000, 60_000);
`,
      'server timeout controls',
    );
    out = replaceOnce(
      out,
      'void start().catch((err) => {\n  logger.error({ err }, "fatal: failed to start server");\n  process.exit(1);\n});',
      `let shutdownStarted = false;

function shutdown(signal: string): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info({ signal }, "server shutdown started");
  const forceTimer = setTimeout(() => {
    logger.error({ signal }, "server shutdown timed out");
    process.exit(1);
  }, boundedIntEnv("SERVER_SHUTDOWN_TIMEOUT_MS", 10_000, 1_000, 60_000));
  forceTimer.unref();
  httpServer.close((err) => {
    if (err) {
      logger.error({ err, signal }, "server shutdown failed");
      process.exit(1);
    }
    logger.info({ signal }, "server shutdown complete");
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  shutdown("uncaughtException");
});

void start().catch((err) => {
  logger.error({ err }, "fatal: failed to start server");
  process.exit(1);
});`,
      'graceful shutdown handlers',
    );
    return out;
  },
);

console.log('[security-ops-hardening-v1] complete');
