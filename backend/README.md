# TradeXYZ Board Backend

This is now a single Node service for the dashboard and APIs.

It serves:
- `GET /` and `GET /index.html` for the board UI;
- `GET /api/feeds` for the stored 15-day TG archive;
- `GET/POST /api/refresh` for latest TG refresh;
- `GET/POST /api/refresh?full=1` for 15-day backfill;
- `GET /api/yahoo/search`, `/api/yahoo/quote`, and `/api/yahoo/chart`.

The browser uses the same origin automatically when the board is not hosted on GitHub Pages, so no `?backend=` parameter is needed after deploying this service.

## Local

From the repo root:

```bash
cd backend
npm install
node server.mjs
```

Open:

```text
http://127.0.0.1:8787/
http://127.0.0.1:8787/api/health
```

If Telegram is blocked on your network, start with a proxy:

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 node server.mjs
```

## Stable Deploy

Deploy the whole repository as one web service. Do not deploy only `backend/`, because the service also needs to serve `index.html`.

Recommended environment variables:

```text
PORT=8787
CORS_ORIGIN=*
POLL_MS=60000
LATEST_MAX_PAGES=4
RETAIN_DAYS=15
DATA_FILE=/data/tg-feeds-store.json
```

Use a persistent disk mounted at `/data`, otherwise the 15-day archive will be lost when the service restarts.

Render is already configured by `render.yaml`:

```text
buildCommand: cd backend && npm ci
startCommand: node backend/server.mjs
```
