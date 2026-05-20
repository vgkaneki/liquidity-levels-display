# Security model — Market Strategy

This document is the audit summary for the multi-user authentication
boundary added to `artifacts/liquidity-heatmap` in April 2026. It
covers the threat model, the auth design, the boundary diagram, the
audit checklist, and the known limitations.

The trading platform itself — liquidity engine, structure engine, DOM
ladder, DOM Align, candle generation, exchange clients, level scoring,
confluence logic — was **NOT** modified by the auth work. The boundary
sits strictly above those modules at `/api/*`.

---

## 1. Threat model

| # | Threat                              | Mitigation                                                                                                          |
|---|-------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| 1 | Account takeover via brute force    | bcrypt (cost 10) + per-IP rate limits on `/api/auth/login` (10/min) and `/api/auth/register` (5/hr).               |
| 2 | Account enumeration via timing/text | Login returns the same generic error for "no such email" and "wrong password", and time-equalizes the bcrypt path. |
| 3 | Session hijack via cookie theft     | `connect.sid` is `HttpOnly`, `SameSite=Lax`, `Secure` in production, 7-day TTL, regenerated on every login.        |
| 4 | Session fixation                    | `req.session.regenerate()` is called on every successful register/login before writing `userId`.                   |
| 5 | CSRF                                | `SameSite=Lax` cookies + tightened CORS (production allowlist via `ALLOWED_ORIGINS`); credentials reject by default. |
| 6 | IDOR on watchlists / alerts / prefs | Every protected route reads `req.session.userId` and filters/checks ownership before SELECT/UPDATE/DELETE.         |
| 7 | Anonymous WebSocket subscription    | The WS upgrade handler runs `sessionMiddleware` and `socket.destroy()`s any upgrade lacking `req.session.userId`.  |
| 8 | Preference exfiltration / pollution | Server allowlist requires keys to match `^thermal[.:]` and caps each value at 64 KB; client mirrors the same scope. |
| 9 | Forged sessions in production       | Boot refuses to start in production without `SESSION_SECRET` set (no silent fallback).                             |

Out of scope for this iteration: MFA, email verification, password reset, account recovery, audit log.

---

## 2. Auth design

| Concern              | Choice                                                                                |
|----------------------|----------------------------------------------------------------------------------------|
| Hash                 | `bcryptjs` cost 10 (pure-JS, no native build).                                         |
| Min password length  | 8 chars (`MIN_PASSWORD_LENGTH`).                                                       |
| Max password length  | 200 chars (`MAX_PASSWORD_LENGTH`) — defends against algorithmic-complexity attacks.    |
| Email format         | `^[^\s@]+@[^\s@]+\.[^\s@]+$`, lowercased + trimmed; uniqueness enforced at the DB.     |
| Session store        | `express-session` in-memory (single-instance deployment); 7-day cookie TTL.            |
| Cookie attrs         | `httpOnly`, `sameSite=Lax`, `secure` (prod only), `maxAge=7d`.                         |
| Session regeneration | On register, login (defeats fixation).                                                 |
| Logout               | `req.session.destroy()` + `res.clearCookie("connect.sid")`.                            |
| Rate limits          | `/api/auth/login`: 10/min/IP. `/api/auth/register`: 5/hour/IP. Bypass when `NODE_ENV=test`. |

---

## 3. Boundary diagram

```
                ┌───────────────────────────────────────────────────────┐
                │  artifacts/liquidity-heatmap (Vite SPA, browser)      │
                │                                                       │
   /login ──────►  Login.tsx ┐                                          │
   /register ───►  Register.tsx ┘──► useAuth().login/register ──┐       │
                                                                │       │
   /, /scanner, /alerts, /market ──► <RequireAuth> ──► <Layout> ─►… platform UI
                                                                │       │
                                                                ▼       │
                                          fetch credentials: include ──►│
                └────────────────────────────────────────────────┬──────┘
                                                                 │
                                                                 ▼
   ┌─────────────────────── artifacts/api-server (Express) ────────────────────┐
   │                                                                           │
   │  app.use(sessionMiddleware)                                               │
   │                                                                           │
   │  ─ public boundary (no auth required)                                     │
   │     • /api/auth/{register,login,logout,me,check}   (rate-limited)         │
   │     • /api/healthz                                                        │
   │                                                                           │
   │  ─── requireAuth gate (rejects 401 if no req.session.userId) ───          │
   │                                                                           │
   │  ─ protected /api/*                                                       │
   │     • /api/watchlists          ─► filtered by userId, default lazy-seeded │
   │     • /api/alerts/{rules,…}    ─► filtered by userId; IDOR-checked        │
   │     • /api/user/preferences    ─► allowlist `^thermal[.:]`, 64KB cap      │
   │     • /api/levels, /api/liquidity, /api/screener, /api/symbol             │
   │                                                                           │
   │  ─ websocket upgrade gate                                                 │
   │     • httpServer.on('upgrade')  ─► sessionMiddleware ─► socket.destroy    │
   │                                    if no req.session.userId               │
   │                                                                           │
   └──────────────────────────────────────────────────────┬────────────────────┘
                                                          │
                                                          ▼
                         ┌──────────────── trading platform ────────────────┐
                         │  liquidity engine • structure engine • DOM ladder│
                         │  DOM Align • candle generation • exchange clients│
                         │  level scoring • confluence logic                │
                         │                                                  │
                         │  >>> UNCHANGED by the auth work <<<              │
                         └──────────────────────────────────────────────────┘
```

---

## 4. Audit checklist

Every protected `/api/*` route handler was reviewed for two invariants:

1. The handler ONLY reaches DB rows owned by `req.session.userId`
   (SELECT/UPDATE/DELETE filtered by `userId`, or via a verified
   ownership join).
2. The handler does not echo any data from another user back to the
   caller.

| Route                                          | userId scoped | IDOR-checked       | Notes |
|------------------------------------------------|:-------------:|:------------------:|-------|
| `GET    /api/watchlists`                       | ✅            | n/a (list)         | Lazy-seeds the user's default. |
| `POST   /api/watchlists`                       | ✅            | n/a (create)       | INSERT sets `userId`. |
| `PUT    /api/watchlists/:id`                   | ✅            | ✅ `loadOwnedWatchlist` | 404 if not owned. |
| `DELETE /api/watchlists/:id`                   | ✅            | ✅                 | Cascades the symbol rows. |
| `POST   /api/watchlists/:id/symbols`           | ✅            | ✅                 |  |
| `POST   /api/watchlists/:id/reorder`           | ✅            | ✅                 |  |
| `DELETE /api/watchlists/:id/symbols/:symbol`   | ✅            | ✅                 |  |
| `GET    /api/alerts/rules`                     | ✅            | n/a (list)         |  |
| `POST   /api/alerts/rules`                     | ✅            | ✅ `resolveSymbolScope` | A `watchlist:<id>` scope is rejected with 400 unless the watchlist belongs to the caller. `watchlist:default` is rewritten to the caller's own default. |
| `PUT    /api/alerts/rules/:id`                 | ✅            | ✅ `loadOwnedRule` + `resolveSymbolScope` | Same scope check applies on edit. |
| `DELETE /api/alerts/rules/:id`                 | ✅            | ✅                 |  |
| `POST   /api/alerts/rules/:id/test`            | ✅            | ✅                 |  |
| `GET    /api/alerts/history`                   | ✅            | ✅ via owned-rule whitelist | Empty list when user has no rules. |
| `POST   /api/alerts/history/:id/resolve`       | ✅            | ✅                 | Orphan history rows are 404 to everyone. |
| `GET    /api/alerts/mutes`                     | ✅            | n/a (list)         |  |
| `POST   /api/alerts/mutes`                     | ✅            | ✅ when ruleId set | Specifying another user's ruleId returns 404. |
| `DELETE /api/alerts/mutes/:id`                 | ✅            | ✅                 | DELETE filtered by `userId`. |
| `GET    /api/alerts/deliveries/:alertId`       | ✅            | ✅                 |  |
| `GET    /api/user/preferences`                 | ✅            | n/a (per-user)     |  |
| `PUT    /api/user/preferences/:key`            | ✅            | n/a (per-user)     | Allowlist `^thermal[.:]`, 64KB cap. |
| `DELETE /api/user/preferences/:key`            | ✅            | n/a (per-user)     |  |
| `WS     /ws` upgrade                           | ✅            | n/a                | `socket.destroy()` if no session. |
| `WS     scanner:alerts` deltas                 | ✅            | ✅                 | `publishScannerAlert` filters by `client.userId === alert.userId`; the snapshot returned at subscribe time is filtered through the same lens. A user subscribed to `scanner:alerts` never sees another user's alert. |
| `GET    /api/levels`, `/api/liquidity`, …      | gated by `requireAuth` | n/a (read-only market data) | These read pooled engine state, no per-user rows. |

Public surface (`/api/auth/*`, `/api/healthz`) was intentionally
left unauthenticated; rate-limited where applicable.

---

## 5. Logout & client-state hygiene

On logout the client:

1. POSTs `/api/auth/logout` (server destroys the session and clears
   `connect.sid`).
2. Calls `clearPlatformLocalStorage()` which removes every
   `localStorage` AND `sessionStorage` key matching `^thermal[.:]`.
3. Redirects to `/login` via `window.location.replace`.

DB-stored preferences are **not** deleted — the next login on any
device will rehydrate them via `GET /api/user/preferences`.

The client never imports nor inspects another user's data; the
server is the only authority on per-user scoping.

---

## 6. Tests

- `artifacts/api-server/src/auth/passwordHash.test.mjs` — bcrypt
  hash/verify correctness, rejection cases, constants.
- `artifacts/api-server/src/routes/auth.test.mjs` — end-to-end
  register → me → seeded watchlist → logout → me boundary, login
  enumeration parity, preference round-trip, watchlist IDOR
  (user A vs user B), alert-rule scope IDOR (B cannot bind a rule
  to A's `watchlist:<id>`), and `watchlist:default` alias resolution.

Both run with `NODE_ENV=test` so the rate limiters are bypassed.

### Cross-user alert isolation (engine-side)

In addition to the route-layer ownership checks above, the alert
engine itself enforces per-user isolation on three internal paths:

1. **Toast delivery (`scanner:alerts` WS channel).** Every
   `publishScannerAlert` payload carries `userId`. The hub iterates
   `subscribers.get("scanner:alerts")` and only sends to sockets
   whose authenticated `client.userId` matches. The snapshot
   handed to a freshly-subscribed socket is filtered the same way,
   so a user opening the app sees only their own recent alerts.
2. **Symbol mute cache.** `userSymbolMutes` is a
   `Map<userId, Map<symbol, until>>`. `isSymbolMuted(userId, symbol)`
   only consults the requesting rule owner's bucket — a mute set
   by user A on `BTCUSDT` cannot suppress user B's `BTCUSDT` alert.
3. **Legacy NULL-userId rows.** Any pre-multi-user alert rule or
   mute row with `user_id IS NULL` is dropped on engine reload —
   it has no owner to deliver to and must not influence anyone
   else's alerts.

---

## 7. Persistence catalog (per-user platform state)

Every per-user piece of platform state lives in exactly one of three
backing surfaces. Engine state (live order books, candle caches,
discovered levels, scoring tables) is intentionally NOT persisted
per-user — it is recomputed live and shared.

### 7.1 Dedicated per-user tables (relational data)

Used when the data has structured relationships, ordering, or
referential constraints that benefit from real columns and joins.

| Domain               | Table(s)                                                     | Owned by | Notes |
|----------------------|--------------------------------------------------------------|:--------:|-------|
| Watchlists           | `watchlists`, `watchlist_symbols`                            | `userId` | Default list lazy-seeded on first login. |
| Alert rules          | `alert_rules`                                                | `userId` | `symbol` may be `watchlist:<id>` — owner-checked. |
| Alert mutes          | `alert_mutes`                                                | `userId` | Per-symbol or per-rule. |
| Alert history        | `alert_history` (joined to owned `alert_rules`)              | `userId` (via rule) | Orphan rows 404. |
| Alert deliveries     | `alert_deliveries`                                           | `userId` | Per-alert log. |
| User accounts        | `users`                                                      | self     | Email + bcrypt hash + timestamps. |

### 7.2 Unified `user_preferences` key/value store (UI / settings blobs)

A single `user_preferences (user_id, key, value JSONB, updated_at)`
table backs every other piece of per-user UI / chart / overlay /
preset state. The server enforces the `^thermal[.:]` key allowlist
and a 64 KB per-value cap; the client mirror in
`lib/preferenceSync.tsx` enforces the same scope on the write path.

We deliberately **do NOT** shard this into `user_layouts`,
`user_chart_settings`, `user_presets`, etc. The reasons:

1. Every blob is opaque JSON consumed by exactly one React module —
   there are no SQL queries that need to filter or join inside any
   of these blobs.
2. The client already serialises the full settings tree into one
   versioned object (`thermal.chartSettings.v1`); a relational
   shape would just re-marshal the same JSON into typed columns
   that the API would immediately re-marshal back into JSON for
   the SPA. That is duplication, not normalisation.
3. The allowlist (`^thermal[.:]`) is the single, auditable bottleneck
   for what the UI is allowed to persist. New blobs can ship without
   a migration as long as their key is in-namespace.
4. Logout hygiene is one regex on both sides
   (`^thermal[.:]` ⇒ wipe localStorage / sessionStorage; the DB
   row is preserved for the next login).

The currently persisted keys (each one mirrored on every write,
rehydrated on every login, scoped strictly to the logged-in
`userId`):

| Key                                  | Purpose                                                       |
|--------------------------------------|---------------------------------------------------------------|
| `thermal.chartSettings.v1`           | Master blob: canvas / scales / grid / watermark / indicator instances (with per-instance config) / liquidity engine display flags / structural-levels overlay flags / overlay line style + palette / active level-display preset state. |
| `thermal.heatmap.symbol.v1`          | Last-viewed symbol on `/` (URL `?symbol=` overrides on cold load). |
| `thermal.heatmap.interval.v1`        | Last-viewed timeframe (validated against the `Interval` union). |
| `thermal.heatmap.rightView.v1`       | Right-panel view: `"watchlist"` or `"screener"`.              |
| `thermal.chartTypeFavorites`         | Pinned chart-type buttons in the toolbar.                     |
| `thermal.intervalFavorites`          | Pinned interval buttons in the toolbar.                       |
| `thermal.indicatorFavorites`         | Pinned indicator buttons in the toolbar.                      |
| `thermal.scanner.mode`               | Scanner mode (legacy / custom-screener).                      |
| `thermal.scanner.activeFilters`      | Custom-screener filter set + sort.                            |
| `thermal.watchlist_name`             | Currently selected watchlist name on the right panel.         |

Bookkeeping keys NOT mirrored to the DB (in `SYNC_BLOCKLIST`):

| Key                            | Why local-only                                            |
|--------------------------------|-----------------------------------------------------------|
| `thermal:auth.returnTo`        | Pre-login URL; meaningless across devices/sessions.       |
| `thermal:prefs.hydrated.for`   | Hydration loop guard (per-tab); writing it back to DB would create a circular rehydrate-on-rehydrate loop. |

### 7.3 Cookie / session

| Surface                    | Storage                            | Notes                                         |
|----------------------------|------------------------------------|-----------------------------------------------|
| Authenticated session      | `connect.sid` cookie               | `HttpOnly`, `SameSite=Lax`, `Secure` in prod. |

### 7.4 Engine state (intentionally NOT persisted per-user)

| Surface                                    | Why shared             |
|--------------------------------------------|------------------------|
| Order books, candles, discovered levels, scoring/confluence tables, exchange clients | Live market data — same for everyone. Persisting per-user would multiply memory usage by user count for zero behavioural benefit and would risk drift between users on the same symbol. |

---

## 8. Known limitations / future work

- No MFA (TOTP, WebAuthn).
- No email verification on registration.
- No password reset flow (would require an email integration).
- Sessions are stored in-memory; horizontal scaling will require
  swapping `express-session` to a shared store (e.g. Redis).
- No audit log of authentication events.
- No password complexity rules beyond length (intentional —
  length-only minimums perform best per current NIST guidance).
- Pre-existing watchlist / alert rule rows from before the multi-user
  rollout retain `user_id = NULL` and are unreachable by the route
  layer; they are preserved for forensic recovery only.

(Section numbers shifted: previous §7 "Known limitations" is now §8
after the persistence catalog was inserted.)
