# Manual Render Free Web Service Deploy

This package is for manual Render deployment. It intentionally does not include render.yaml, so Render will not route you into Blueprint/IaC setup.

## Render settings

Create a new Render **Web Service** and connect this GitHub repository.

- Runtime: Node
- Branch: main
- Root Directory: leave blank
- Build Command:

```bash
corepack enable && corepack prepare pnpm@10.23.0 --activate && pnpm install --frozen-lockfile && pnpm run build:render
```

- Start Command:

```bash
pnpm start
```

- Health Check Path:

```text
/api/healthz
```

## Environment variables

Required/recommended:

```text
NODE_ENV=production
BASE_PATH=/
STATIC_DIR=artifacts/liquidity-heatmap/dist/public
SESSION_SECRET=<generate a long random string>
ALLOWED_ORIGINS=https://YOUR-SERVICE.onrender.com
PUBLIC_APP_URL=https://YOUR-SERVICE.onrender.com
```

Optional, only if those features are used:

```text
DATABASE_URL=<Render Postgres external/internal connection string>
AI_INTEGRATIONS_OPENAI_API_KEY=<optional>
VAPID_PUBLIC_KEY=<optional>
VAPID_PRIVATE_KEY=<optional>
VAPID_SUBJECT=<optional>
```

## Free plan warning

Render free web services sleep after idle time and are not appropriate for live-trading production. Use this deployment as a public preview/test environment.
