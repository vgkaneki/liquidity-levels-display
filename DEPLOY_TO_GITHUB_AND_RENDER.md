# Upload to GitHub and deploy on Render

## 1. Create a new GitHub repo

Recommended repo name:

```text
liquidity-levels-display
```

Create it on GitHub, then push this folder:

```bash
git init
git add .
git commit -m "Initial Render-ready liquidity levels display"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/liquidity-levels-display.git
git push -u origin main
```

## 2. Deploy to Render Free

Use **Render Dashboard → New → Blueprint** and connect this GitHub repo. Render will read `render.yaml` from the repo root and create:

- `liquidity-levels-display` free Node web service
- `liquidity-levels-db` free Postgres database

No manual build/start commands are required when using Blueprint. The service auto-detects its Render URL through `RENDER_EXTERNAL_URL` for same-origin API and CSRF checks.

Optional after first deploy: set `PUBLIC_APP_URL=https://YOUR-SERVICE.onrender.com` if you use alert links or push-notification subjects.

## 3. Verify

Open:

```text
https://YOUR-SERVICE.onrender.com/api/healthz
```

Expected response:

```json
{"ok":true,"t":...}
```

Then open the app URL:

```text
https://YOUR-SERVICE.onrender.com
```

## Important free-tier limits

Render Free web services spin down after idle time and wake on the next request. Free Postgres databases expire after 30 days unless upgraded. Use the free tier for preview/testing, not live trading production.
