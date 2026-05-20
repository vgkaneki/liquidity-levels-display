# Production Runtime Configuration

This document tracks repo-side operational expectations for deployment hardening. Real secret values must stay in Render or the host secret store, never in git.

## Required production settings

- `NODE_ENV`: set to `production`.
- `PORT`: set by the host.
- `SESSION_SECRET`: required in production; the server refuses to boot without it.
- `DATABASE_URL`: required for persistent users, sessions, preferences, alerts, watchlists, liquidation history, and level registry persistence.
- `ALLOWED_ORIGINS`: comma-separated list of trusted app origins for credentialed browser requests.

## Optional runtime controls

- `API_RATE_LIMIT_WINDOW_MS` and `API_RATE_LIMIT_MAX`: API rate limit window and maximum requests.
- `SERVER_REQUEST_TIMEOUT_MS`, `SERVER_HEADERS_TIMEOUT_MS`, `SERVER_KEEPALIVE_TIMEOUT_MS`, and `SERVER_SHUTDOWN_TIMEOUT_MS`: HTTP lifecycle timeout controls.
- `ENABLE_CRITICAL_BOOT_WARM`, `ENABLE_MARKET_OVERVIEW_WARM`, and `BACKGROUND_START_DELAY_MS`: workload and warm-up controls.

## External services

API keys for third-party services must only be added through the deployment platform's secret UI. Do not commit `.env` files, private keys, certificates, or downloaded credential bundles.

## Deployment checklist

- Confirm production has a real session secret.
- Confirm database backups are enabled in the hosting provider.
- Confirm health checks use `/api/healthz` or `/api/readyz`.
- Confirm credentialed CORS origins match the deployed app domains.
- Confirm Render/host environment variables are scoped to production only.
- Confirm the protected-engine guard passes during build verification.
