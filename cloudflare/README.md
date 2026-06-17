# Cloudflare deployment

This deploys the board as a Cloudflare Worker with static assets and same-origin APIs.

## What runs on Cloudflare

- Static assets: `index.html`, `tg-feeds.json`, `jin10-calendar.json`
- APIs:
  - `GET /api/health`
  - `GET /api/feeds`
  - `POST /api/refresh`
  - `GET /api/ai-calendar`
  - `POST /api/ai-calendar/refresh`
  - `POST /api/news-analysis`
- Persistence: Cloudflare KV binding `CACHE`
- AI: OpenAI-compatible endpoint configured by Worker variables and `AI_API_KEY` secret

## Setup

1. Create a Cloudflare KV namespace named `tradexyz_cache`.
2. Copy its namespace id into `wrangler.toml`:

   ```toml
   [[kv_namespaces]]
   binding = "CACHE"
   id = "your_namespace_id"
   ```

3. Set the AI key as a Cloudflare secret:

   ```powershell
   npx wrangler secret put AI_API_KEY
   ```

4. Build and deploy:

   ```powershell
   npm install
   npm run cf:deploy
   ```

## Notes

- Do not commit `AI_API_KEY`.
- Telegram public-page refresh is best-effort on Cloudflare. If Telegram blocks the Worker request, `/api/refresh` keeps the previous KV data or the GitHub snapshot instead of returning an empty feed.
- `POST /api/ai-calendar/refresh` and `POST /api/news-analysis` require `AI_API_KEY`.
