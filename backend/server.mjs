import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = resolve(process.env.DATA_FILE || `${__dirname}/data/tg-feeds-store.json`);
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS || 15);
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const POLL_MS = Number(process.env.POLL_MS || 60_000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CHANNELS = [
  { key: "bwe", channel: "BWEtradfi", archiveMax: 5000, maxPages: 160 },
  { key: "jin10", channel: "jin10light", archiveMax: 8000, maxPages: 260 },
  { key: "poly", channel: "PolyBeats_Bot", archiveMax: 5000, maxPages: 180 }
];

let STORE = {
  updatedAt: null,
  source: "telegram-public-html-backend",
  retentionDays: RETAIN_DAYS,
  channels: Object.fromEntries(CHANNELS.map(c => [c.key, { channel: c.channel, items: [], archiveComplete: false }]))
};
let refreshPromise = null;
let lastRefreshError = "";

function nowIso() {
  return new Date().toISOString();
}

function decodeHtml(s = "") {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function textFromHtml(html = "") {
  return decodeHtml(String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/blockquote>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " "))
    .split("\n")
    .map(x => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trim()}...` : s;
}

function tagsFromText(text) {
  const tags = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(/#[\p{L}\p{N}_A-Za-z]+/gu)) {
    const tag = m[0];
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags.slice(0, 12);
}

function cleanupText(text, key) {
  let out = String(text || "");
  if (key === "poly") {
    out = out
      .replace(/订阅BlockBeats会员可查看完整预测市场新闻内容[\s\S]*$/i, "")
      .replace(/如需订阅BlockBeats会员请添加[\s\S]*$/i, "")
      .replace(/让你更早看到未来，关注[\s\S]*$/i, "")
      .replace(/See tomorrow, today\.[\s\S]*$/i, "");
  }
  return out.trim();
}

function splitTitleBody(text, key) {
  const lines = String(text || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => !/^[-—_]{6,}$/.test(x))
    .filter(x => !/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(x));
  if (key === "bwe") {
    let idx = lines.findIndex(x => /[\u4e00-\u9fff]/.test(x));
    if (idx < 0) idx = 0;
    return {
      title: truncate((lines[idx] || "").replace(/^Tradfin:\s*/i, ""), 130),
      body: truncate(lines.filter((_, i) => i !== idx).join(" ").replace(/^Tradfin:\s*/i, ""), 320)
    };
  }
  return {
    title: truncate(lines[0] || "", key === "poly" ? 130 : 120),
    body: truncate(lines.slice(1).join(" "), key === "poly" ? 640 : 320)
  };
}

function beijingClock(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function parseTelegramHtml(html, cfg, previous = []) {
  const prev = new Map((previous || []).map(x => [String(x.id || ""), x]));
  const starts = [...html.matchAll(new RegExp(`data-post="${cfg.channel}/(\\d+)"`, "g"))];
  const items = [];
  const now = Date.now();
  for (let i = 0; i < starts.length; i++) {
    const id = starts[i][1];
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.indexOf("</main>", start);
    const block = html.slice(start, end > start ? end : undefined);
    const textHtml = block.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "";
    const text = cleanupText(textFromHtml(textHtml), cfg.key);
    if (!text) continue;
    const dt = block.match(/<time datetime="([^"]+)"/)?.[1] || "";
    const ts = dt ? Date.parse(dt) : null;
    const old = prev.get(id);
    const { title, body } = splitTitleBody(text, cfg.key);
    if (!title) continue;
    items.push({
      id,
      url: `https://t.me/${cfg.channel}/${id}`,
      title,
      body,
      tags: tagsFromText(text),
      ts: Number.isFinite(ts) ? ts : null,
      time: Number.isFinite(ts) ? beijingClock(ts) : "",
      receivedAt: old?.receivedAt || now,
      receivedTime: true
    });
  }
  return items.sort((a, b) => Number(b.id) - Number(a.id));
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 tradexyz-board-backend/1.0"
      }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function archiveReachedCutoff(items) {
  const cutoff = Date.now() - RETAIN_MS;
  return (items || []).some(item => {
    const ts = Number(item?.ts || 0);
    return Number.isFinite(ts) && ts > 0 && ts <= cutoff;
  });
}

function mergeArchive(fetched, previous, cfg) {
  const cutoff = Date.now() - RETAIN_MS;
  const map = new Map();
  for (const item of [...(previous || []), ...(fetched || [])]) {
    if (!item?.id) continue;
    const ts = Number(item.ts || 0);
    if (Number.isFinite(ts) && ts > 0 && ts < cutoff) continue;
    const old = map.get(String(item.id));
    map.set(String(item.id), {
      ...old,
      ...item,
      receivedAt: old?.receivedAt || item.receivedAt || Date.now(),
      receivedTime: true
    });
  }
  return [...map.values()]
    .sort((a, b) => (Number(b.ts || 0) - Number(a.ts || 0)) || (Number(b.id) - Number(a.id)))
    .slice(0, cfg.archiveMax);
}

async function fetchChannelArchive(cfg, previous, opts = {}) {
  const previousIds = new Set((previous || []).map(x => String(x.id || "")).filter(Boolean));
  const cutoff = Date.now() - RETAIN_MS;
  const fetched = [];
  const hadFullArchive = archiveReachedCutoff(previous);
  const fullBackfill = opts.full || !hadFullArchive;
  let before = null;
  let overlapped = false;
  let reachedCutoff = false;
  let pages = 0;
  for (; pages < cfg.maxPages; pages++) {
    const url = before ? `https://t.me/s/${cfg.channel}?before=${before}` : `https://t.me/s/${cfg.channel}`;
    const html = await fetchText(url);
    const pageItems = parseTelegramHtml(html, cfg, previous);
    if (!pageItems.length) break;
    fetched.push(...pageItems);
    if (pageItems.some(x => previousIds.has(String(x.id)))) overlapped = true;
    const oldest = pageItems[pageItems.length - 1];
    const oldestTs = Number(oldest?.ts || 0);
    reachedCutoff = Number.isFinite(oldestTs) && oldestTs > 0 && oldestTs <= cutoff;
    if (reachedCutoff) break;
    if (!fullBackfill && overlapped && pages >= 1) break;
    const nextBefore = Number(oldest?.id || 0);
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;
  }
  const items = mergeArchive(fetched, previous, cfg);
  return { items, pages: pages + 1, archiveComplete: reachedCutoff || archiveReachedCutoff(items) };
}

async function ensureStoreDir() {
  await mkdir(dirname(DATA_FILE), { recursive: true });
}

async function loadStore() {
  try {
    STORE = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    try {
      STORE = JSON.parse(await readFile(resolve(`${__dirname}/../tg-feeds.json`), "utf8"));
    } catch {
      // Keep empty initial store.
    }
  }
  STORE.retentionDays = RETAIN_DAYS;
}

async function saveStore() {
  await ensureStoreDir();
  await writeFile(DATA_FILE, JSON.stringify(STORE, null, 2) + "\n", "utf8");
}

async function refreshFeeds(opts = {}) {
  if (refreshPromise && !opts.forceNew) return refreshPromise;
  refreshPromise = (async () => {
    const startedAt = Date.now();
    const channels = {};
    for (const cfg of CHANNELS) {
      const prev = STORE.channels?.[cfg.key]?.items || [];
      try {
        const result = await fetchChannelArchive(cfg, prev, opts);
        channels[cfg.key] = {
          channel: cfg.channel,
          items: result.items,
          archiveComplete: result.archiveComplete,
          pages: result.pages
        };
      } catch (error) {
        channels[cfg.key] = {
          channel: cfg.channel,
          items: prev,
          archiveComplete: archiveReachedCutoff(prev),
          error: error.message
        };
      }
    }
    STORE = {
      updatedAt: nowIso(),
      refreshMs: Date.now() - startedAt,
      source: "telegram-public-html-backend",
      retentionDays: RETAIN_DAYS,
      channels
    };
    await saveStore();
    lastRefreshError = "";
    return STORE;
  })().catch(error => {
    lastRefreshError = error.message;
    throw error;
  }).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function publicFeeds() {
  return STORE;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        updatedAt: STORE.updatedAt,
        refreshing: !!refreshPromise,
        lastRefreshError,
        channels: Object.fromEntries(Object.entries(STORE.channels || {}).map(([k, v]) => [k, {
          count: v.items?.length || 0,
          newest: v.items?.[0]?.id || null,
          oldest: v.items?.[v.items.length - 1]?.id || null,
          archiveComplete: !!v.archiveComplete,
          error: v.error || ""
        }]))
      });
      return;
    }
    if (url.pathname === "/api/feeds") {
      sendJson(res, 200, publicFeeds());
      return;
    }
    if (url.pathname === "/api/refresh") {
      const full = url.searchParams.get("full") === "1";
      const data = await refreshFeeds({ full, forceNew: true });
      sendJson(res, 200, data);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

await loadStore();
server.listen(PORT, () => {
  console.log(`tradexyz backend listening on :${PORT}`);
  refreshFeeds({ full: false }).catch(error => console.error("initial refresh failed", error));
  setInterval(() => refreshFeeds({ full: false }).catch(error => console.error("poll refresh failed", error)), POLL_MS);
});
