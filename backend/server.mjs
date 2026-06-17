import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`using outbound proxy ${PROXY_URL}`);
}

const YAHOO_CACHE_TTL_MS = Number(process.env.YAHOO_CACHE_TTL_MS || 15_000);
const YAHOO_SEARCH_CACHE_TTL_MS = Number(process.env.YAHOO_SEARCH_CACHE_TTL_MS || 60_000);
const YAHOO_CACHE = new Map();
const YAHOO_ALIASES = [
  { symbol: "NVDA", nameZh: "英伟达", aliases: ["英伟达", "辉达", "nvidia", "nvda"] },
  { symbol: "TSLA", nameZh: "特斯拉", aliases: ["特斯拉", "tesla", "tsla"] },
  { symbol: "AAPL", nameZh: "苹果", aliases: ["苹果", "apple", "aapl"] },
  { symbol: "MSFT", nameZh: "微软", aliases: ["微软", "microsoft", "msft"] },
  { symbol: "GOOGL", nameZh: "谷歌", aliases: ["谷歌", "alphabet", "google", "googl", "goog"] },
  { symbol: "AMZN", nameZh: "亚马逊", aliases: ["亚马逊", "amazon", "amzn"] },
  { symbol: "META", nameZh: "Meta", aliases: ["meta", "facebook", "脸书", "fb"] },
  { symbol: "AMD", nameZh: "AMD", aliases: ["amd", "超威"] },
  { symbol: "AVGO", nameZh: "博通", aliases: ["博通", "broadcom", "avgo"] },
  { symbol: "TSM", nameZh: "台积电", aliases: ["台积电", "tsmc", "tsm"] },
  { symbol: "BABA", nameZh: "阿里巴巴", aliases: ["阿里巴巴", "阿里", "baba", "alibaba"] },
  { symbol: "PDD", nameZh: "拼多多", aliases: ["拼多多", "pdd"] },
  { symbol: "NIO", nameZh: "蔚来", aliases: ["蔚来", "nio"] },
  { symbol: "XPEV", nameZh: "小鹏汽车", aliases: ["小鹏", "小鹏汽车", "xpeng", "xpev"] },
  { symbol: "LI", nameZh: "理想汽车", aliases: ["理想", "理想汽车", "li auto", "li"] },
  { symbol: "^GSPC", nameZh: "标普500", aliases: ["标普", "标普500", "sp500", "s&p500", "s&p 500", "spy"] },
  { symbol: "^IXIC", nameZh: "纳斯达克综合", aliases: ["纳指综合", "纳斯达克综合", "nasdaq composite", "ixic"] },
  { symbol: "^NDX", nameZh: "纳斯达克100", aliases: ["纳指", "纳斯达克100", "nasdaq100", "ndx", "qqq"] },
  { symbol: "^DJI", nameZh: "道琼斯", aliases: ["道指", "道琼斯", "dow", "dow jones", "dji"] },
  { symbol: "GC=F", nameZh: "黄金期货", aliases: ["黄金", "gold", "comex黄金", "gc=f"] },
  { symbol: "SI=F", nameZh: "白银期货", aliases: ["白银", "silver", "si=f"] },
  { symbol: "CL=F", nameZh: "WTI原油", aliases: ["原油", "wti", "美油", "cl=f"] },
  { symbol: "BZ=F", nameZh: "布伦特原油", aliases: ["布伦特", "brent", "bz=f"] },
  { symbol: "DX-Y.NYB", nameZh: "美元指数", aliases: ["美元指数", "dxy", "dollar index", "dx-y.nyb"] },
  { symbol: "BTC-USD", nameZh: "比特币", aliases: ["比特币", "btc", "bitcoin", "btc-usd"] },
  { symbol: "ETH-USD", nameZh: "以太坊", aliases: ["以太坊", "eth", "ethereum", "eth-usd"] }
];

let STORE = {
  updatedAt: null,
  source: "telegram-public-html-backend",
  retentionDays: RETAIN_DAYS,
  channels: Object.fromEntries(CHANNELS.map(c => [c.key, { channel: c.channel, items: [], archiveComplete: false }]))
};
let refreshPromise = null;
let backfillPromise = null;
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
  const fullBackfill = !!opts.full;
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

async function runRefresh(opts = {}) {
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
    mode: opts.full ? "backfill" : "latest",
    channels
  };
  await saveStore();
  lastRefreshError = "";
  return STORE;
}

async function refreshFeeds(opts = {}) {
  if (backfillPromise && !opts.forceNew) return STORE;
  if (refreshPromise && !opts.forceNew) return refreshPromise;
  refreshPromise = runRefresh({ ...opts, full: false }).catch(error => {
    lastRefreshError = error.message;
    throw error;
  }).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function backfillFeeds() {
  if (backfillPromise) return backfillPromise;
  backfillPromise = runRefresh({ full: true }).catch(error => {
    lastRefreshError = error.message;
    throw error;
  }).finally(() => {
    backfillPromise = null;
  });
  return backfillPromise;
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

function normalizeYahooText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[，,、/\\|]+/g, " ")
    .replace(/\s+/g, "");
}

function findYahooAlias(raw) {
  const q = normalizeYahooText(raw);
  if (!q) return null;
  for (const item of YAHOO_ALIASES) {
    const keys = [item.symbol, item.nameZh, ...(item.aliases || [])].map(normalizeYahooText);
    if (keys.includes(q)) return item;
  }
  for (const item of YAHOO_ALIASES) {
    const keys = [item.nameZh, ...(item.aliases || [])].map(normalizeYahooText).filter(x => x.length >= 2);
    if (keys.some(x => q.includes(x))) return item;
  }
  return null;
}

function normalizeYahooSymbol(raw) {
  const s = String(raw || "").trim();
  if (/^[A-Za-z0-9.^=_-]{1,32}$/.test(s) && (/[.^=_-]/.test(s) || s === s.toUpperCase())) return s.toUpperCase();
  const alias = findYahooAlias(raw);
  if (alias) return alias.symbol;
  if (/^[A-Za-z0-9.^=_-]{1,32}$/.test(s)) return s.toUpperCase();
  return "";
}

function yahooAliasForSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  return YAHOO_ALIASES.find(x => x.symbol.toUpperCase() === s) || null;
}

function yahooBjTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

async function cachedYahoo(key, ttl, fn) {
  const old = YAHOO_CACHE.get(key);
  if (old && Date.now() - old.ts < ttl) return old.value;
  const value = await fn();
  YAHOO_CACHE.set(key, { ts: Date.now(), value });
  if (YAHOO_CACHE.size > 500) {
    for (const k of YAHOO_CACHE.keys()) {
      YAHOO_CACHE.delete(k);
      if (YAHOO_CACHE.size <= 420) break;
    }
  }
  return value;
}

async function fetchYahooJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 tradexyz-board-backend/1.0"
      }
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function yahooQuoteFromChart(symbol, payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart empty");
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];
  const lastClose = closes.findLast?.(x => x != null && Number.isFinite(Number(x)));
  const price = Number(meta.regularMarketPrice ?? lastClose ?? NaN);
  const prev = Number(meta.previousClose ?? meta.chartPreviousClose ?? NaN);
  const change = Number.isFinite(price) && Number.isFinite(prev) ? price - prev : null;
  const changePct = change != null && prev ? change / prev * 100 : null;
  const updatedSec = Number(meta.regularMarketTime || timestamps[timestamps.length - 1] || 0);
  const alias = yahooAliasForSymbol(symbol);
  const volume = volumes.findLast?.(x => x != null && Number.isFinite(Number(x))) ?? meta.regularMarketVolume ?? null;
  return {
    symbol,
    nameZh: alias?.nameZh || "",
    name: meta.shortName || meta.longName || alias?.nameZh || symbol,
    price: Number.isFinite(price) ? price : null,
    change,
    changePct,
    volume: Number.isFinite(Number(volume)) ? Number(volume) : null,
    currency: meta.currency || "",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    marketState: meta.marketState || "",
    updatedAt: updatedSec ? updatedSec * 1000 : null,
    updatedAtBeijing: updatedSec ? yahooBjTime(updatedSec * 1000) : "",
    fieldsZh: {
      "代码": symbol,
      "中文名": alias?.nameZh || "",
      "名称": meta.shortName || meta.longName || alias?.nameZh || symbol,
      "价格": Number.isFinite(price) ? price : null,
      "涨跌额": change,
      "涨跌幅": changePct,
      "成交量": Number.isFinite(Number(volume)) ? Number(volume) : null,
      "市场状态": meta.marketState || "",
      "交易所": meta.fullExchangeName || meta.exchangeName || "",
      "币种": meta.currency || "",
      "更新时间(北京时间)": updatedSec ? yahooBjTime(updatedSec * 1000) : ""
    }
  };
}

async function yahooQuote(symbol) {
  const clean = normalizeYahooSymbol(symbol);
  if (!clean) throw new Error(`unsupported symbol: ${symbol}`);
  return cachedYahoo(`quote:${clean}`, YAHOO_CACHE_TTL_MS, async () => {
    const pathSymbol = encodeURIComponent(clean);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pathSymbol}?range=1d&interval=5m&includePrePost=true`;
    return yahooQuoteFromChart(clean, await fetchYahooJson(url));
  });
}

async function yahooChart(symbol, range = "1d", interval = "5m") {
  const clean = normalizeYahooSymbol(symbol);
  if (!clean) throw new Error(`unsupported symbol: ${symbol}`);
  const safeRange = /^[0-9]+[dmy]$|^ytd$|^max$/i.test(range) ? range : "1d";
  const safeInterval = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/i.test(interval) ? interval : "5m";
  return cachedYahoo(`chart:${clean}:${safeRange}:${safeInterval}`, YAHOO_CACHE_TTL_MS, async () => {
    const pathSymbol = encodeURIComponent(clean);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pathSymbol}?range=${encodeURIComponent(safeRange)}&interval=${encodeURIComponent(safeInterval)}&includePrePost=true`;
    const payload = await fetchYahooJson(url);
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0] || {};
    const timestamps = result?.timestamp || [];
    return {
      quote: yahooQuoteFromChart(clean, payload),
      points: timestamps.map((t, i) => ({
        ts: t * 1000,
        timeBeijing: yahooBjTime(t * 1000),
        open: quote.open?.[i] ?? null,
        high: quote.high?.[i] ?? null,
        low: quote.low?.[i] ?? null,
        close: quote.close?.[i] ?? null,
        volume: quote.volume?.[i] ?? null
      })).filter(x => x.close != null)
    };
  });
}

async function yahooSearch(q) {
  const raw = String(q || "").trim();
  const alias = findYahooAlias(raw);
  const rows = [];
  if (alias) rows.push({ symbol: alias.symbol, nameZh: alias.nameZh, source: "中文别名" });
  if (raw) {
    const searchTerm = alias ? alias.symbol : raw;
    try {
      const payload = await cachedYahoo(`search:${searchTerm}`, YAHOO_SEARCH_CACHE_TTL_MS, async () => {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchTerm)}&quotesCount=8&newsCount=0`;
        return fetchYahooJson(url);
      });
      for (const x of payload?.quotes || []) {
        if (!x?.symbol) continue;
        const known = yahooAliasForSymbol(x.symbol);
        rows.push({
          symbol: x.symbol,
          nameZh: known?.nameZh || "",
          name: x.shortname || x.longname || x.name || "",
          exchange: x.exchDisp || x.exchange || "",
          type: x.quoteType || "",
          source: "Yahoo搜索"
        });
      }
    } catch (error) {
      if (!alias) rows.push({ symbol: raw, error: error.message });
    }
  }
  const dedup = [];
  const seen = new Set();
  for (const row of rows) {
    const key = String(row.symbol || "").toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }
  const quotes = [];
  for (const row of dedup.slice(0, 6)) {
    try {
      quotes.push({ ...row, quote: await yahooQuote(row.symbol) });
    } catch (error) {
      quotes.push({ ...row, error: error.message });
    }
  }
  return { query: raw, matchedAlias: alias || null, results: quotes };
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
        backfilling: !!backfillPromise,
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
      const data = full ? await backfillFeeds() : await refreshFeeds({ forceNew: true });
      sendJson(res, 200, data);
      return;
    }
    if (url.pathname === "/api/yahoo/search") {
      sendJson(res, 200, await yahooSearch(url.searchParams.get("q") || ""));
      return;
    }
    if (url.pathname === "/api/yahoo/quote") {
      const symbols = (url.searchParams.get("symbols") || url.searchParams.get("symbol") || "")
        .split(/[,\s，、]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .slice(0, 16);
      const results = [];
      for (const symbol of symbols) {
        try {
          results.push(await yahooQuote(symbol));
        } catch (error) {
          results.push({ symbol, error: error.message });
        }
      }
      sendJson(res, 200, { results });
      return;
    }
    if (url.pathname === "/api/yahoo/chart") {
      const symbol = url.searchParams.get("symbol") || "";
      const range = url.searchParams.get("range") || "1d";
      const interval = url.searchParams.get("interval") || "5m";
      sendJson(res, 200, await yahooChart(symbol, range, interval));
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
  setTimeout(() => backfillFeeds().catch(error => console.error("initial backfill failed", error)), 5_000);
  setInterval(() => refreshFeeds({ full: false }).catch(error => console.error("poll refresh failed", error)), POLL_MS);
  setInterval(() => backfillFeeds().catch(error => console.error("scheduled backfill failed", error)), 6 * 60 * 60 * 1000);
});
