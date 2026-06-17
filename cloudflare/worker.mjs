const CHANNELS = [
  { key: "bwe", channel: "BWEtradfi" },
  { key: "jin10", channel: "jin10light" },
  { key: "poly", channel: "PolyBeats_Bot" }
];

const RETAIN_MS = 15 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/health") return json({ ok: true, runtime: "cloudflare-worker", at: nowIso(), aiConfigured: Boolean(env.AI_API_KEY) });
      if (url.pathname === "/api/feeds" && request.method === "GET") return json(await loadFeeds(env));
      if (url.pathname === "/api/refresh" && request.method === "POST") return json(await refreshFeeds(env));
      if (url.pathname === "/api/ai-calendar" && request.method === "GET") return json(await loadAiCalendar(env));
      if (url.pathname === "/api/ai-calendar/refresh" && request.method === "POST") return json(await refreshAiCalendar(env));
      if (url.pathname === "/api/news-analysis" && request.method === "POST") return json(await analyzeNews(env, await request.json().catch(() => ({}))));
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error), at: nowIso() }, 500);
    }
  }
};

async function loadFeeds(env) {
  const cached = await kvJson(env, "feeds");
  if (cached?.channels) return { ...cached, ok: true, cached: true };
  const snapshot = await fetchSnapshot(env, "tg-feeds.json");
  return normalizeStore(snapshot, "github-snapshot");
}

async function refreshFeeds(env) {
  const previous = await loadFeeds(env);
  const channels = {};
  const errors = [];
  for (const cfg of CHANNELS) {
    const prev = previous.channels?.[cfg.key]?.items || [];
    try {
      const html = await fetchText(`https://t.me/s/${cfg.channel}`);
      const fetched = parseTelegramHtml(html, cfg, prev);
      channels[cfg.key] = { channel: cfg.channel, items: mergeItems(fetched, prev), archiveComplete: false };
    } catch (error) {
      channels[cfg.key] = { channel: cfg.channel, items: prev, error: error.message || String(error), archiveComplete: false };
      errors.push(`${cfg.channel}: ${error.message || String(error)}`);
    }
  }
  const store = normalizeStore({ updatedAt: nowIso(), source: "cloudflare-telegram-public-html", retentionDays: 15, channels, error: errors.join("; ") }, "cloudflare-telegram-public-html");
  await putKvJson(env, "feeds", store);
  return { ...store, ok: errors.length === 0, refreshError: errors.join("; ") };
}

async function loadAiCalendar(env) {
  const cached = await kvJson(env, "ai-calendar");
  if (cached?.days) return { ...cached, ok: true, cached: true };
  return { ok: true, updatedAt: null, status: env.AI_API_KEY ? "empty" : "not_configured", source: "cloudflare-worker", model: env.AI_MODEL || "gpt-5.5", days: [], error: env.AI_API_KEY ? "" : "AI_API_KEY not configured" };
}

async function refreshAiCalendar(env) {
  if (!env.AI_API_KEY) {
    const out = { ok: false, updatedAt: nowIso(), status: "not_configured", source: "cloudflare-worker", model: env.AI_MODEL || "gpt-5.5", days: [], error: "AI_API_KEY not configured" };
    await putKvJson(env, "ai-calendar", out);
    return out;
  }
  const [calendarRows, feeds] = await Promise.all([calendarRowsForAi(env), loadFeeds(env)]);
  const newsRows = newsRowsForAi(feeds);
  const result = await callAi(env, aiCalendarPrompt(calendarRows, newsRows), 1800);
  const days = normalizeAiCalendar(parseAiJson(result.text));
  const out = { ok: true, updatedAt: nowIso(), status: "ok", source: result.source, model: env.AI_MODEL || "gpt-5.5", days, error: "" };
  await putKvJson(env, "ai-calendar", out);
  return out;
}

async function analyzeNews(env, body) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const cached = await kvJson(env, "news-analysis") || { items: {} };
  if (!env.AI_API_KEY) return { ...cached, ok: false, updatedAt: nowIso(), status: "not_configured", error: "AI_API_KEY not configured" };
  const cleaned = rawItems.map(cleanNewsInput).filter(x => x.title).slice(0, 24);
  const missing = cleaned.filter(x => !cached.items?.[x.id]);
  if (missing.length) {
    const result = await callAi(env, newsAnalysisPrompt(missing), 1800);
    const normalized = normalizeNewsAnalysis(parseAiJson(result.text), missing.map(x => x.id), env);
    const items = { ...(cached.items || {}) };
    normalized.forEach(x => { items[x.id] = x; });
    const keep = Object.entries(items).sort((a, b) => String(b[1].updatedAt || "").localeCompare(String(a[1].updatedAt || ""))).slice(0, 1500);
    const out = { ok: true, updatedAt: nowIso(), status: "ok", source: result.source, model: env.AI_MODEL || "gpt-5.5", items: Object.fromEntries(keep), error: "" };
    await putKvJson(env, "news-analysis", out);
    return out;
  }
  return { ...cached, ok: true, cached: true };
}

async function callAi(env, prompt, maxTokens) {
  const model = env.AI_MODEL || "gpt-5.5";
  const base = (env.AI_BASE_URL || "https://zhiyu.api.trytrythisai.com/v1").replace(/\/$/, "");
  const mode = env.AI_API_MODE || "auto";
  if (mode !== "chat") {
    const res = await postAi(env, `${base}/responses`, { model, input: prompt, store: false, temperature: 0.1, max_output_tokens: maxTokens });
    if (res.ok) return { source: "ai-responses", text: responsesText(res.payload) };
    if (mode === "responses") throw new Error(`AI responses HTTP ${res.status}: ${truncate(res.raw, 500)}`);
  }
  const res = await postAi(env, `${base}/chat/completions`, { model, messages: [{ role: "system", content: "Return strict JSON only. No markdown." }, { role: "user", content: prompt }], temperature: 0.1, max_tokens: maxTokens });
  if (res.ok) return { source: "ai-chat", text: chatText(res.payload) };
  throw new Error(`AI chat HTTP ${res.status}: ${truncate(res.raw, 500)}`);
}

async function postAi(env, url, body) {
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${env.AI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch {}
  return { ok: res.ok, status: res.status, raw, payload };
}

async function calendarRowsForAi(env) {
  const snapshot = await fetchSnapshot(env, "jin10-calendar.json").catch(() => null);
  const rows = [];
  collectCalendarRows(snapshot?.rows || snapshot, "calendar", "", rows);
  const start = weekStartDateKey(beijingDateKey());
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
    const item = { tradeDateKey, rawDateKey: dateKey, time: dateKey !== tradeDateKey && time !== "待定" ? `明晨 ${time}` : time, title, country: row.country || "", score, star: Number(row.star || 0), values: [row.actual ? `实际 ${row.actual}` : "", row.consensus ? `预期 ${row.consensus}` : "", row.previous ? `前值 ${row.previous}` : ""].filter(Boolean), assets: calAssets(title) };
    let key = `${item.tradeDateKey}|${item.time}|${title}`;
    if (/FOMC|美联储.*利率决定|经济预期摘要/i.test(title)) key = `${item.tradeDateKey}|${item.time}|FOMC`;
    if (/沃什|新闻发布会|记者会/i.test(title)) key = `${item.tradeDateKey}|${item.time}|FED-PRESSER`;
    if (/储备余额利率/i.test(title)) continue;
    if (!map.has(key) || map.get(key).score < item.score) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => a.tradeDateKey.localeCompare(b.tradeDateKey) || b.score - a.score || a.time.localeCompare(b.time)).slice(0, 70);
}

function newsRowsForAi(store) {
  const start = weekStartDateKey(beijingDateKey());
  const end = addDaysKey(start, 6);
  const rows = [];
  for (const [sourceKey, sourceName] of [["bwe", "BWE"], ["jin10", "金十TG"], ["poly", "PolyBeats"]]) {
    for (const item of (store.channels?.[sourceKey]?.items || []).slice(0, 120)) {
      const dateKey = beijingDateKey(Number(item.ts || item.receivedAt || Date.now()));
      if (dateKey < start || dateKey > end) continue;
      const text = [item.title, item.body, (item.tags || []).join(" ")].join(" ");
      if (!/(FOMC|美联储|利率|CPI|PCE|PPI|非农|就业|原油|EIA|OPEC|黄金|白银|美债|国债|NVDA|英伟达|芯片|半导体|AI|OPEX|休市|地缘|伊朗|以色列)/i.test(text)) continue;
      rows.push({ dateKey, source: sourceName, title: truncate(item.title, 90), body: truncate(item.body, 130), assets: calAssets(text, item.tags || []) });
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
6. 语言必须短，event 不超过 14 个汉字，reason 不超过 20 个汉字。
7. assets 只能从这些里选：SPY, QQQ, NVDA, 美元, 美债, 黄金, 白银, 原油, 能源股, BTC。
8. 没有重点的日期 events 为空数组，summary 写“无高优先级”。

返回格式：
{"days":[{"dateKey":"YYYY-MM-DD","summary":"当天最重要的一句话","events":[{"time":"21:30","event":"非农数据","assets":["SPY","QQQ","美元","黄金"],"reason":"改降息预期"}]}]}

原始日历：
${JSON.stringify(calendarRows)}

相关快讯：
${JSON.stringify(newsRows)}`;
}

function newsAnalysisPrompt(items) {
  return `你是美股新闻交易情报分析员。请把每条中文/英文快讯压缩成结构化交易影响。
用户只要知道：利好谁、利空谁、强度、为什么、能不能追。
规则：
1. 严格返回 JSON，不要 markdown。
2. 每条输入都返回一个对象，id 必须与输入一致。
3. assets 只能从这些里选：SPY, QQQ, NVDA, 美元, 美债, 黄金, 白银, 原油, 能源股, BTC。
4. direction 只能是：偏利好、偏利空、多空都有、中性观察。
5. score 为 0-99。
6. reason 不超过 18 个汉字。
7. action 只能是：立即关注、先看价格确认、值得盯盘、只做背景。
8. chaseRisk 只能是：低、中、高。
返回格式：
{"items":[{"id":"...","assets":["QQQ"],"bull":["美元"],"bear":["QQQ"],"direction":"偏利空","score":72,"reason":"降息预期降温","action":"先看价格确认","chaseRisk":"中"}]}

输入快讯：
${JSON.stringify(items)}`;
}

function normalizeAiCalendar(obj) {
  const start = weekStartDateKey(beijingDateKey());
  const byDate = new Map((obj.days || []).map(d => [d.dateKey, d]));
  return Array.from({ length: 7 }, (_, i) => {
    const dateKey = addDaysKey(start, i);
    const d = byDate.get(dateKey) || {};
    const events = Array.isArray(d.events) ? d.events.slice(0, 3).map(e => ({ time: truncate(e.time || "待定", 12), event: truncate(e.event || "市场事件", 20), assets: Array.isArray(e.assets) ? e.assets.slice(0, 5).map(x => truncate(x, 8)) : [], reason: truncate(e.reason || "", 24) })) : [];
    return { dateKey, summary: truncate(d.summary || (events.length ? events[0].event : "无高优先级"), 24), events };
  });
}

function normalizeNewsAnalysis(input, ids, env) {
  const allowedAssets = new Set(["SPY", "QQQ", "NVDA", "美元", "美债", "黄金", "白银", "原油", "能源股", "BTC"]);
  const allowedDirection = new Set(["偏利好", "偏利空", "多空都有", "中性观察"]);
  const allowedAction = new Set(["立即关注", "先看价格确认", "值得盯盘", "只做背景"]);
  const allowedRisk = new Set(["低", "中", "高"]);
  const byId = new Map((input.items || []).map(x => [String(x.id || ""), x]));
  return ids.map(id => {
    const x = byId.get(id) || {};
    const assets = Array.isArray(x.assets) ? x.assets.filter(a => allowedAssets.has(a)).slice(0, 6) : [];
    const bull = Array.isArray(x.bull) ? x.bull.filter(a => allowedAssets.has(a)).slice(0, 6) : [];
    const bear = Array.isArray(x.bear) ? x.bear.filter(a => allowedAssets.has(a)).slice(0, 6) : [];
    const score = Math.max(0, Math.min(99, Math.round(Number(x.score || 0))));
    return { id, assets, bull, bear, direction: allowedDirection.has(x.direction) ? x.direction : "中性观察", score, reason: truncate(x.reason || "影响风险偏好", 18), action: allowedAction.has(x.action) ? x.action : (score >= 85 ? "立即关注" : (score >= 70 ? "先看价格确认" : (score >= 55 ? "值得盯盘" : "只做背景"))), chaseRisk: allowedRisk.has(x.chaseRisk) ? x.chaseRisk : "中", updatedAt: nowIso(), model: env.AI_MODEL || "gpt-5.5" };
  });
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
    const text = textFromHtml(textHtml).trim();
    if (!text) continue;
    const ts = Date.parse(block.match(/<time datetime="([^"]+)"/)?.[1] || "");
    const old = prev.get(id);
    const [title, ...bodyParts] = text.split(/\n+/).filter(Boolean);
    items.push({ id, url: `https://t.me/${cfg.channel}/${id}`, title: truncate(title, 180), body: truncate(bodyParts.join(" "), 400), tags: tagsFromText(text), ts: Number.isFinite(ts) ? ts : null, time: Number.isFinite(ts) ? beijingClock(ts) : "", receivedAt: old?.receivedAt || now, receivedTime: true });
  }
  return items.sort((a, b) => Number(b.id) - Number(a.id));
}

function mergeItems(fetched, previous) {
  const cutoff = Date.now() - RETAIN_MS;
  const byId = new Map();
  for (const item of [...(fetched || []), ...(previous || [])]) {
    const t = Number(item.ts || item.receivedAt || 0);
    if (Number.isFinite(t) && t > 0 && t < cutoff) continue;
    if (!byId.has(String(item.id))) byId.set(String(item.id), item);
  }
  return [...byId.values()].sort((a, b) => Number(b.ts || b.receivedAt || 0) - Number(a.ts || a.receivedAt || 0)).slice(0, 8000);
}

function normalizeStore(input, source) {
  const channels = {};
  for (const cfg of CHANNELS) {
    channels[cfg.key] = { channel: cfg.channel, ...(input?.channels?.[cfg.key] || {}), items: input?.channels?.[cfg.key]?.items || [] };
  }
  return { updatedAt: input?.updatedAt || nowIso(), source: input?.source || source, retentionDays: 15, channels, error: input?.error || "" };
}

async function fetchSnapshot(env, name) {
  const base = env.GITHUB_RAW_BASE || "https://raw.githubusercontent.com/ameko39/tradexyz-board/main";
  const res = await fetch(`${base.replace(/\/$/, "")}/${name}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`snapshot ${name} HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 tradexyz-board-worker/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function collectCalendarRows(node, kind, dateHint, out) {
  if (!node) return;
  if (Array.isArray(node)) return node.forEach(x => collectCalendarRows(x, kind, dateHint, out));
  if (typeof node !== "object") return;
  if (node.indicator_name || node.event_content || node.exchange_name || node.name || node.title) {
    out.push({ __kind: kind, __dateHint: dateHint || "", ...node });
    return;
  }
  for (const k of Object.keys(node)) collectCalendarRows(node[k], kind, /^20\d{2}-\d{2}-\d{2}$/.test(k) ? k : dateHint, out);
}

function calTitle(row) { return String(row.indicator_name || row.name || row.event_content || row.title || "财经日历事件").trim(); }
function calDateKey(row) { return findDateInText(row.date) || findDateInText(row.pub_time) || findDateInText(row.publish_time) || findDateInText(row.event_time) || findDateInText(row.time) || row.__dateHint || beijingDateKey(); }
function calTime(row) { return normalizeCalTime(row.time_period || row.event_time || row.pub_time || row.publish_time || row.time_status || row.time); }
function tradeDateKeyForCal(row, dateKey, time, title) {
  const h = Number((String(time || "").match(/^(\d{1,2}):/) || [])[1]);
  if (Number.isFinite(h) && h < 6 && /(美国|FOMC|美联储|Fed|沃什|利率决定|利率决议)/i.test([title, row.country].join(" "))) return addDaysKey(dateKey, -1);
  return dateKey;
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

function cleanNewsInput(item) {
  return { id: truncate(item.analysisId || item.key || item.id || item.url || item.title || crypto.randomUUID(), 120), source: truncate(item.source || "NEWS", 30), title: truncate(item.title || "", 180), body: truncate(item.body || "", 260), tags: Array.isArray(item.tags) ? item.tags.slice(0, 10).map(x => truncate(x, 20)) : [], timeText: truncate(item.timeText || "", 40) };
}

function parseAiJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("AI response JSON parse failed");
}
function responsesText(payload) { return payload?.output_text || (payload?.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("\n"); }
function chatText(payload) { return payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || ""; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function nowIso() { return new Date().toISOString(); }
function truncate(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1).trim()}...` : s; }
function beijingClock(ms) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)); }
function beijingDateKey(ms = Date.now()) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)); return `${part(p, "year")}-${part(p, "month")}-${part(p, "day")}`; }
function part(parts, type) { return parts.find(p => p.type === type)?.value || ""; }
function dateKeyToMs(key) { const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0) : Date.now(); }
function addDaysKey(key, n) { return beijingDateKey(dateKeyToMs(key) + n * 86400000); }
function weekStartDateKey(key = beijingDateKey()) { const base = dateKeyToMs(key); const day = new Date(base).getUTCDay() || 7; return beijingDateKey(base - ((day + 6) % 7) * 86400000); }
function findDateInText(v) { return String(v || "").match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/)?.[0]?.replace(/\//g, "-").replace(/-(\d)(?=-|$)/g, "-0$1") || ""; }
function normalizeCalTime(v) { const s = String(v || "").trim(); const m = s.match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : (s && /待定|全天|休市/.test(s) ? s.slice(0, 10) : "待定"); }
function tagsFromText(text) { return [...String(text || "").matchAll(/#[\p{L}\p{N}_A-Za-z]+/gu)].map(m => m[0]).slice(0, 12); }
function textFromHtml(html) { return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))); }
async function kvJson(env, key) { const text = await env.CACHE?.get(key); if (!text) return null; try { return JSON.parse(text); } catch { return null; } }
async function putKvJson(env, key, value) { if (env.CACHE) await env.CACHE.put(key, JSON.stringify(value)); }
