# TradeXYZ Board Backend

This backend makes TG refresh stable for the static dashboard.

It:
- polls public Telegram pages for `BWEtradfi`, `jin10light`, and `PolyBeats_Bot`;
- stores a 15-day JSON archive on disk;
- exposes `GET /api/feeds`;
- exposes `GET/POST /api/refresh?full=1` for manual refresh/backfill;
- supports CORS for the GitHub Pages frontend.

## Local

```bash
cd backend
node server.mjs
```

Open:

```text
http://127.0.0.1:8787/api/health
```

## Deploy

Deploy this `backend` folder to Render, Railway, Fly.io, or a VPS.

Environment variables:

```text
PORT=8787
CORS_ORIGIN=https://ameko39.github.io
POLL_MS=60000
RETAIN_DAYS=15
DATA_FILE=/data/tg-feeds-store.json
```

After deployment, set this in the browser console on the dashboard:

```js
localStorage.setItem("tradexyz-backend-url", "https://YOUR-BACKEND-DOMAIN");
location.reload();
```

The frontend will use the backend first and fall back to `tg-feeds.json` if the backend is unavailable.
