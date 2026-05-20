# Liquidity Levels Display

Professional crypto liquidity, order-flow, structural levels, DOM/Bookmap-style heatmap, scanner, alerts, and API workspace.

## Render deployment

This repository includes `render.yaml` for a one-service Render deployment:

- Render Web Service: `liquidity-levels-display` on the Free instance type
- Render Postgres: `liquidity-levels-db` on the Free database type
- Frontend and API served from the same origin so `/api` and `/ws` continue to work without a separate proxy

### Build command

```bash
corepack enable && corepack prepare pnpm@10.23.0 --activate && pnpm install --frozen-lockfile && pnpm run build:render
```

### Start command

```bash
pnpm start
```

### Required environment

`render.yaml` configures the required production variables. In the Render dashboard, set these after the first deploy URL is known:

- `ALLOWED_ORIGINS=https://YOUR-SERVICE.onrender.com`
- `PUBLIC_APP_URL=https://YOUR-SERVICE.onrender.com`

Optional features:

- `AI_INTEGRATIONS_OPENAI_API_KEY` for AI commentary
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for push alerts

## Local development

```bash
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm install
pnpm --filter @workspace/api-server dev
pnpm --filter @workspace/liquidity-heatmap dev
```

## Protected engine note

The Render patch only adds same-origin static serving and deployment metadata. It does not change liquidity formulas, structural formulas, confluence scoring, touch classification, DOM/Bookmap logic, absorption logic, or any protected engine math.
