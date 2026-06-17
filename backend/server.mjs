import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const STATIC_DIR = resolve(process.env.STATIC_DIR || `${__dirname}/..`);
const DATA_FILE = resolve(process.env.DATA_FILE || `${__dirname}/data/tg-feeds-store.json`);
const AI_CAL_FILE = resolve(process.env.AI_CAL_FILE || `${__dirname}/data/ai-calendar.json`);
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS || 15);
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const POLL_MS = Number(process.env.POLL_MS || 60_000);
const LATEST_MAX_PAGES = Number(process.env.LATEST_MAX_PAGES || 4);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const CHANNELS = [
  { key: "bwe", channel: "BWEtradfi", archiveMax: 5000, maxPages: 160 },
  { key: "jin10", channel: "jin10light", archiveMax: 8000, maxPages: 260 },
  { key: "poly", channel: "PolyBeats_Bot", archiveMax: 5000, maxPages: 180 }
];
const STATIC_FILES = new Set(["/", "/index.html", "/tg-feeds.json", "/jin10-calendar.json"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`using outbound proxy ${PROXY_URL}`);
}

let STORE = {
  updatedAt: null,
  source: "telegram-public-html-backend",
  retentionDays: RETAIN_DAYS,
  channels: Object.fromEntries(CHANNELS.map(c => [c.key, { channel: c.channel, items: [], archiveComplete: false }]))
};
let refreshPromise = null;
let backfillPromise = null;
let lastRefreshError = "";
let AI_CALENDAR = {
  updatedAt: null,
  status: OPENAI_API_KEY ? "empty" : "not_configured",
  source: "ai-calendar",
  model: OPENAI_MODEL,
  days: [],
  error: OPENAI_API_KEY ? "" : "OPENAI_API_KEY not configured"
};
let aiCalendarPromise = null;

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

function beijingDateParts(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ms));
  const get = type => Number(parts.find(x => x.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dateKeyFromParts(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function beijingDateKey(ms = Date.now()) {
  const p = beijingDateParts(ms);
  return dateKeyFromParts(p.year, p.month, p.day);
}

function dateKeyToMs(key) {
  const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0) : Date.now();
}

function addDaysKey(key, n) {
  return beijingDateKey(dateKeyToMs(key) + n * 24 * 60 * 60 * 1000);
}

function weekStartDateKey(key = beijingDateKey()) {
  const base = dateKeyToMs(key);
  const day = new Date(base).getUTCDay() || 7;
  return beijingDateKey(base - ((day + 6) % 7) * 24 * 60 * 60 * 1000);
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
  const fullBackfill = !!opts.full;
  let before = null;
  let overlapped = false;
  let reachedCutoff = false;
  let pages = 0;
  const maxPages = fullBackfill ? cfg.maxPages : Math.min(cfg.maxPages, LATEST_MAX_PAGES);
  for (; pages < maxPages; pages++) {
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

async function loadAiCalendar() {
  try {
    AI_CALENDAR = JSON.parse(await readFile(AI_CAL_FILE, "utf8"));
  } catch {
    // Keep initial empty state.
  }
  AI_CALENDAR.model = AI_CALENDAR.model || OPENAI_MODEL;
  if (!OPENAI_API_KEY && !AI_CALENDAR.days?.length) {
    AI_CALENDAR.status = "not_configured";
    AI_CALENDAR.error = "OPENAI_API_KEY not configured";
  }
}

async function saveStore() {
  await ensureStoreDir();
  await writeFile(DATA_FILE, JSON.stringify(STORE, null, 2) + "\n", "utf8");
}

async function saveAiCalendar() {
  await ensureStoreDir();
  await writeFile(AI_CAL_FILE, JSON.stringify(AI_CALENDAR, null, 2) + "\n", "utf8");
}

async function runRefresh(opts = {}) {
  const startedAt = Date.now();
  const channels = {};
  const errors = [];
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
      errors.push(`${cfg.channel}: ${error.message}`);
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
  lastRefreshError = errors.join("; ");
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

async function sendStatic(reqPath, res) {
  const path = reqPath === "/" ? "/index.html" : reqPath;
  if (!STATIC_FILES.has(path)) return false;
  const file = resolve(STATIC_DIR, path.slice(1));
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": path === "/index.html" ? "no-store" : "no-cache"
  });
  res.end(body);
  return true;
}

function publicFeeds() {
  return STORE;
}

function findDateInText(s) {
  const m = String(s || "").match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  return m ? dateKeyFromParts(m[1], m[2], m[3]) : "";
}

function normalizeCalTime(raw) {
  const s = String(raw || "").trim();
  if (!s) return "待定";
  if (/待定|待确定/i.test(s)) return "待定";
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : s.slice(0, 8);
}

function collectCalendarRows(node, kind, dateHint, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(x => collectCalendarRows(x, kind, dateHint, out));
    return;
  }
  if (typeof node !== "object") return;
  const rowLike = node.indicator_name || node.event_content || node.exchange_name || node.name || node.title;
  if (rowLike) {
    out.push({ __kind: kind, __dateHint: dateHint || "", ...node });
    return;
  }
  for (const k of Object.keys(node)) {
    const nextDate = /^20\d{2}-\d{2}-\d{2}$/.test(k) ? k : dateHint;
    collectCalendarRows(node[k], kind, nextDate, out);
  }
}

function calTitle(row) {
  if (row.__kind === "holiday") {
    return String(row.event_content || [row.country, row.exchange_name, row.holiday_name || row.name || row.title].filter(Boolean).join(" ")).trim();
  }
  return String(row.indicator_name || row.name || row.event_content || row.title || "财经日历事件").trim();
}

function calDateKey(row) {
  return findDateInText(row.date) || findDateInText(row.pub_time) || findDateInText(row.publish_time) || findDateInText(row.event_time) || findDateInText(row.time) || row.__dateHint || beijingDateKey();
}

function calTime(row) {
  return normalizeCalTime(row.time_period || row.event_time || row.pub_time || row.publish_time || row.time_status || row.time);
}

function tradeDateKeyForCal(row, dateKey, time, title) {
  const h = Number((String(time || "").match(/^(\d{1,2}):/) || [])[1]);
  const text = [title, row.country].join(" ");
  if (Number.isFinite(h) && h < 6 && /(美国|FOMC|美联储|Fed|沃什|利率决定|利率决议)/i.test(text)) {
    return addDaysKey(dateKey, -1);
  }
  return dateKey;
}

function calAssets(title, tags = []) {
  const text = [title, tags.join(" ")].join(" ");
  const out = [];
  const add = x => { if (x && !out.includes(x)) out.push(x); };
  if (/FOMC|美联储|Fed|鲍威尔|沃什|降息|加息|利率|点阵图|央行/i.test(text)) { add("美元"); add("美债"); add("黄金"); add("QQQ"); }
  if (/CPI|PCE|PPI|通胀|非农|就业|失业|初请|零售销售|PMI|ISM|GDP/i.test(text)) { add("SPY"); add("QQQ"); add("美元"); add("黄金"); }
  if (/国债|美债|收益率|Treasury|auction|拍卖/i.test(text)) { add("美债"); add("QQQ"); add("黄金"); }
  if (/原油|WTI|Brent|布伦特|OPEC|EIA|API|库存|能源/i.test(text)) { add("原油"); add("能源股"); add("黄金"); }
  if (/白银|silver/i.test(text)) add("白银");
  if (/黄金|gold/i.test(text)) add("黄金");
  if (/NVIDIA|NVDA|英伟达|芯片|半导体|AI|人工智能|HBM|DRAM|AMD|TSM|ASML|MU|AVGO/i.test(text)) { add("NVDA"); add("QQQ"); }
  if (/休市|OPEX|期权|三巫|四巫|再平衡|资金流|月末|季末/i.test(text)) { add("SPY"); add("QQQ"); }
  if (/战争|冲突|袭击|伊朗|以色列|中东|制裁|关税/i.test(text)) { add("黄金"); add("原油"); add("美元"); }
  if (!out.length) { add("SPY"); add("QQQ"); }
  return out.slice(0, 5);
}

function calScore(row, title) {
  const text = [title, row.country, row.unit, row.event_time, row.time_period].join(" ");
  let score = Number(row.star || row.important || 0) * 10;
  if (/美国|FOMC|Fed|美联储|NFP|非农|ADP|ISM|初请|JOLTS/i.test(text)) score += 18;
  if (/CPI|PCE|PPI|通胀|物价/i.test(text)) score += 18;
  if (/FOMC|Fed|美联储|鲍威尔|沃什|利率决议|利率决定|点阵图|央行/i.test(text)) score += 22;
  if (/EIA|API|原油|OPEC|库存|天然气/i.test(text)) score += 12;
  if (/国债|拍卖|Treasury|收益率/i.test(text)) score += 14;
  if (/休市|假期|holiday|OPEX|Triple Witching|期权|交割|到期/i.test(text)) score += 10;
  return score;
}

async function calendarRowsForAi() {
  const rows = [];
  try {
    const snapshot = JSON.parse(await readFile(resolve(`${STATIC_DIR}/jin10-calendar.json`), "utf8"));
    collectCalendarRows(snapshot.rows || snapshot, "calendar", "", rows);
  } catch {
    // Calendar snapshot is optional.
  }
  const today = beijingDateKey();
  const start = weekStartDateKey(today);
  const end = addDaysKey(start, 6);
  const map = new Map();
  for (const row of rows) {
    const title = calTitle(row);
    const dateKey = calDateKey(row);
    const time = calTime(row);
    const tradeDateKey = tradeDateKeyForCal(row, dateKey, time, title);
    if (tradeDateKey < start || tradeDateKey > end) continue;
    const score = calScore(row, title);
    if (score < 28) continue;
    const item = {
      tradeDateKey,
      rawDateKey: dateKey,
      time: dateKey !== tradeDateKey && time !== "待定" ? `明晨 ${time}` : time,
      title,
      country: row.country || "",
      score,
      star: Number(row.star || 0),
      values: [row.actual ? `实际 ${row.actual}` : "", row.consensus ? `预期 ${row.consensus}` : "", row.previous ? `前值 ${row.previous}` : ""].filter(Boolean),
      assets: calAssets(title)
    };
    let key = `${item.tradeDateKey}|${item.time}|${title}`;
    if (/FOMC|美联储.*利率决定|经济预期摘要/i.test(title)) key = `${item.tradeDateKey}|${item.time}|FOMC`;
    if (/沃什|新闻发布会|记者会/i.test(title)) key = `${item.tradeDateKey}|${item.time}|FED-PRESSER`;
    if (/储备余额利率/i.test(title)) continue;
    if (!map.has(key) || map.get(key).score < item.score) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => (a.tradeDateKey.localeCompare(b.tradeDateKey)) || (b.score - a.score) || a.time.localeCompare(b.time)).slice(0, 70);
}

function newsRowsForAi() {
  const start = weekStartDateKey(beijingDateKey());
  const end = addDaysKey(start, 6);
  const rows = [];
  for (const [sourceKey, sourceName] of [["bwe", "BWE"], ["jin10", "金十TG"], ["poly", "PolyBeats"]]) {
    for (const item of (STORE.channels?.[sourceKey]?.items || []).slice(0, 120)) {
      const dateKey = beijingDateKey(Number(item.ts || item.receivedAt || Date.now()));
      if (dateKey < start || dateKey > end) continue;
      const text = [item.title, item.body, (item.tags || []).join(" ")].join(" ");
      if (!/(FOMC|美联储|利率|CPI|PCE|PPI|非农|就业|原油|EIA|OPEC|黄金|白银|美债|国债|NVDA|英伟达|芯片|半导体|AI|OPEX|休市|地缘|伊朗|以色列)/i.test(text)) continue;
      rows.push({
        dateKey,
        source: sourceName,
        title: truncate(item.title, 90),
        body: truncate(item.body, 130),
        assets: calAssets(text, item.tags || [])
      });
    }
  }
  return rows.slice(0, 60);
}

function aiCalendarPrompt(calendarRows, newsRows) {
  const today = beijingDateKey();
  const start = weekStartDateKey(today);
  const end = addDaysKey(start, 6);
  return `你是美股交易员日历编辑。今天是北京时间 ${today}。请把原始财经日历和快讯整理成给普通用户看的「本周市场关注」。

目标用户不懂宏观术语，只想知道：哪天、几点、什么事、会影响哪些资产。

规则：
1. 输出严格 JSON，不要 markdown。
2. 覆盖 ${start} 到 ${end} 共 7 天，每天一个对象。
3. 每天最多 3 个事件，只保留真正会影响交易的事件。
4. FOMC/美联储/美国凌晨事件按美股交易日理解；输入里 time 若是“明晨 02:00”，就保留这个说法。
5. 合并重复项，例如美联储利率上限/下限/经济预期摘要合并为“FOMC利率决议”，新闻发布会单独保留。
6. 语言必须短，适合傻瓜式展示。event 不超过 14 个汉字，reason 不超过 20 个汉字。
7. assets 只能从这些里选：SPY, QQQ, NVDA, 美元, 美债, 黄金, 白银, 原油, 能源股, BTC。
8. 没有重点的日期 events 为空数组，summary 写“无高优先级”。

返回格式：
{
  "days": [
    {
      "dateKey": "YYYY-MM-DD",
      "summary": "当天最重要的一句话",
      "events": [
        {"time": "21:30", "event": "非农数据", "assets": ["SPY","QQQ","美元","黄金"], "reason": "改降息预期"}
      ]
    }
  ]
}

原始日历：
${JSON.stringify(calendarRows)}

相关快讯：
${JSON.stringify(newsRows)}`;
}

function parseAiJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("AI response JSON parse failed");
}

function normalizeAiCalendar(obj) {
  const start = weekStartDateKey(beijingDateKey());
  const byDate = new Map((obj.days || []).map(d => [d.dateKey, d]));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dateKey = addDaysKey(start, i);
    const d = byDate.get(dateKey) || {};
    const events = Array.isArray(d.events) ? d.events.slice(0, 3).map(e => ({
      time: truncate(e.time || "待定", 12),
      event: truncate(e.event || "市场事件", 20),
      assets: Array.isArray(e.assets) ? e.assets.slice(0, 5).map(x => truncate(x, 8)) : [],
      reason: truncate(e.reason || "", 24)
    })) : [];
    days.push({ dateKey, summary: truncate(d.summary || (events.length ? events[0].event : "无高优先级"), 24), events });
  }
  return days;
}

async function runAiCalendarRefresh(opts = {}) {
  if (!OPENAI_API_KEY) {
    AI_CALENDAR = { ...AI_CALENDAR, updatedAt: nowIso(), status: "not_configured", error: "OPENAI_API_KEY not configured" };
    await saveAiCalendar();
    return AI_CALENDAR;
  }
  const calendarRows = await calendarRowsForAi();
  const newsRows = newsRowsForAi();
  const prompt = aiCalendarPrompt(calendarRows, newsRows);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      store: false,
      temperature: 0.1,
      max_output_tokens: 1800
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  const text = payload.output_text || (payload.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("\n");
  const days = normalizeAiCalendar(parseAiJson(text));
  AI_CALENDAR = {
    updatedAt: nowIso(),
    status: "ok",
    source: "openai",
    model: OPENAI_MODEL,
    calendarInputCount: calendarRows.length,
    newsInputCount: newsRows.length,
    days,
    error: ""
  };
  await saveAiCalendar();
  return AI_CALENDAR;
}

async function refreshAiCalendar(opts = {}) {
  if (aiCalendarPromise && !opts.forceNew) return aiCalendarPromise;
  aiCalendarPromise = runAiCalendarRefresh(opts).catch(async error => {
    AI_CALENDAR = { ...AI_CALENDAR, updatedAt: nowIso(), status: "error", error: error.message };
    await saveAiCalendar().catch(() => {});
    throw error;
  }).finally(() => {
    aiCalendarPromise = null;
  });
  return aiCalendarPromise;
}

function msUntilNextBeijingNoon() {
  const now = Date.now();
  const parts = beijingDateParts(now);
  let target = Date.UTC(parts.year, parts.month - 1, parts.day, 4, 0, 0);
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target - now;
}

function scheduleAiCalendarRefresh() {
  setTimeout(() => {
    refreshAiCalendar({ forceNew: true }).catch(error => console.error("scheduled ai calendar failed", error));
    setInterval(() => refreshAiCalendar({ forceNew: true }).catch(error => console.error("scheduled ai calendar failed", error)), 24 * 60 * 60 * 1000);
  }, msUntilNextBeijingNoon());
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
        aiCalendar: {
          status: AI_CALENDAR.status,
          updatedAt: AI_CALENDAR.updatedAt,
          model: AI_CALENDAR.model || OPENAI_MODEL,
          refreshing: !!aiCalendarPromise,
          error: AI_CALENDAR.error || ""
        },
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
    if (url.pathname === "/api/ai-calendar") {
      sendJson(res, 200, { ...AI_CALENDAR, refreshing: !!aiCalendarPromise });
      return;
    }
    if (url.pathname === "/api/ai-calendar/refresh") {
      const data = await refreshAiCalendar({ forceNew: true });
      sendJson(res, 200, data);
      return;
    }
    if (req.method === "GET" && await sendStatic(url.pathname, res)) {
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

await loadStore();
await loadAiCalendar();
server.listen(PORT, () => {
  console.log(`tradexyz backend listening on :${PORT}`);
  refreshFeeds({ full: false }).catch(error => console.error("initial refresh failed", error));
  setTimeout(() => backfillFeeds().catch(error => console.error("initial backfill failed", error)), 5_000);
  setTimeout(() => {
    if (OPENAI_API_KEY && (!AI_CALENDAR.updatedAt || AI_CALENDAR.status === "empty")) {
      refreshAiCalendar({ forceNew: true }).catch(error => console.error("initial ai calendar failed", error));
    }
  }, 10_000);
  scheduleAiCalendarRefresh();
  setInterval(() => refreshFeeds({ full: false }).catch(error => console.error("poll refresh failed", error)), POLL_MS);
  setInterval(() => backfillFeeds().catch(error => console.error("scheduled backfill failed", error)), 6 * 60 * 60 * 1000);
});
