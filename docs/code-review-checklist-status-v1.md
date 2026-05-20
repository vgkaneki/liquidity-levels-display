# Code Review Checklist Status Map V1

This status map tracks progress against the 195-item production hardening checklist without claiming unfinished external infrastructure work is complete.

## Protected engine policy

These checklist passes must not change liquidity/structural formulas, confluence or scoring formulas, touch classification, DOM/Bookmap logic, absorption logic, scanner/reversal scoring, or level placement math. Current repo-side hardening is limited to runtime, transport, deployment, documentation, verification, UI safety, route-boundary validation, and operational controls.

## Current repo-side progress

| Area | Status | Repo-side coverage | Still pending or external |
| --- | --- | --- | --- |
| 1-15 Security | Partial | Auth validation, password hashing, session secret enforcement, credentialed CORS, body limits, login/register rate limiting, security headers patch, request IDs, CSRF origin guard, API rate limiter, local secret ignores, alert webhook validation, push endpoint validation. | External secret rotation, WAF/CDN rules, provider TLS controls, production security review. |
| 16-30 Performance / latency | Partial | Central Render patch runner, startup warm opt-in controls, background workload throttling, fast static shell, frontend request debounce, websocket visual coalescing, chart stability helpers, runtime-pressure checks. | Real device/browser profiling, provider metrics review, load test thresholds. |
| 31-45 Data validation / bugs | Partial | Auth input validation, safe error handling, watchlist validation, alert validation, push validation, symbol query validation, screener proxy input caps, and verification scripts for key route-boundary markers. Runtime verification catches key unsafe regressions. | Remaining specialized route inputs and non-engine regression tests. |
| 46-60 Architecture / design | Partial | Centralized Render patch chain, explicit protected-engine guard, separated frontend chart helper modules, dedicated route-input hardening verifier. | Permanent migration of stable patch behavior into source files over time. |
| 61-75 Monitoring / observability | Partial | Pino HTTP logging, health/readiness probes, request ID propagation, performance diagnostics badge. | External APM, hosted log retention, alert routing, uptime provider setup. |
| 76-91 Code quality / maintainability | Partial | Package build/typecheck scripts, protected-engine verification, documented runtime expectations, Render pre/post verification, route hardening verifier in Render script. | CI expansion was attempted but blocked by tool safety checks; more lint and route tests still pending. |
| 92-106 Frontend / UX | Partial | Lazy route loading, app error boundary, performance diagnostics badge, request debounce, last-good chart fallback, chart readiness gates. | Accessibility polish pass attempted but blocked; still needs manual a11y verification. |
| 107-121 Backend / API | Partial | JSON/body limits, sessions, auth, public health checks, protected API middleware, rate limit patch, request ID error envelopes, watchlist/alert/push/symbol/screener route-boundary hardening. | Complete OpenAPI/schema documentation and validation coverage for remaining specialized endpoints. |
| 122-136 Deployment / DevOps | Partial | Render build script uses patch runner and pre/post build verification. Production runtime docs added. Route-input verifier now runs in Render verification scripts. | Provider backup settings, rollback drills, secret manager configuration, disaster recovery plan. |
| 137-146 Dependency / security | Partial | pnpm-only install guard, pnpm workspace minimum release age, dependency overrides, local credential ignores. | Automated dependency audit workflow and recurring vulnerability review. |
| 147-156 Database | Partial | Schema includes hashed password field, unique email, preferences index, and persistent runtime tables. | Managed DB backup/restore policy, migration audit, retention policy. |
| 157-166 WebSocket / realtime | Partial | Shared channel coalescing, diagnostics helper, backend workload cleanup, rate-pressure controls. | Production websocket soak/load testing and provider connection limit tuning. |
| 167-175 Caching | Partial | Foreground API microcache markers, analytics demand gating, candle pressure caps, static asset caching. | Cache invalidation tests and provider-side cache policy review. |
| 176-185 API design | Partial | Safer error envelopes, health/readiness endpoints, and route-boundary validation for the highest-risk user-input APIs. | API versioning, full typed contract docs, schema coverage for every route. |
| 186-195 Testing / QA | Partial | Engine tests, route soak tests, render verification script, protected-engine guard, post-build output checks, route input hardening verifier. | Full CI workflow expansion, e2e browser tests, load tests, accessibility tests. |

## Completed in the latest hardening sequence

- Local `.env` and private key/certificate artifacts are ignored while keeping example environment files commit-safe.
- Production runtime configuration notes document required production env vars, optional runtime controls, secret handling, health checks, CORS, and database backup expectations.
- Security operations patch is wired into the Render patch runner.
- The patch runner now normalizes nested template literal escaping before executing the security operations patch.
- Security operations patch source was hardened so generated app code uses safe string concatenation and Express-compatible rate limit header settings.
- Watchlist route input validation now covers watchlist names, symbol add/delete canonicalization, reorder caps, and symbol format checks.
- Alert route input validation now covers alert names, symbols, ids, sink count, params size, throttle/history/mute bounds, public HTTPS webhook validation, and Discord webhook path validation.
- Push subscription validation now normalizes HTTPS endpoints, blocks private/local endpoint hosts, and validates key sizes/formats.
- Symbol route validation now caps and validates search/debug inputs before registry reads.
- Screener proxy validation now caps catalog query size, query param size, scan body size, and sidecar port configuration before proxying.
- Route-input verification was added and wired into `verify:render`, `verify:render:post`, and `build:render`.

## External-only items

The following checklist items cannot be completed by repository edits alone and must be configured in Render, the database provider, GitHub, CDN/WAF, or monitoring vendor tools:

- Real production secrets and secret rotation.
- TLS/certificate provider settings.
- Database backups, restore drills, and retention windows.
- External APM/log aggregation/uptime monitoring.
- WAF, CDN, bot protection, and DDoS controls.
- Disaster recovery and rollback drills.
- Production load testing with live provider limits.

## Next safe repo-side passes

1. Continue specialized route-by-route input validation inspection outside protected engine files.
2. Add non-engine tests for auth, health/readiness, rate-limit behavior, route validation, and error envelopes.
3. Expand API contract documentation for validated endpoints.
4. Convert stable patch behavior into permanent source files after Render stability is confirmed.
