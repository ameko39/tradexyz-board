import { readFile, writeFile } from "node:fs/promises";

const OUT = "tg-feeds.json";
const RETAIN_DAYS = 15;
const RETAIN_MS = RETAIN_DAYS * 24 * 60 * 60 * 1000;
const CHANNELS = [
  { key: "bwe", channel: "BWEtradfi", archiveMax: 800, maxPages: 40, warmPages: 20 },
  { key: "jin10", channel: "jin10light", archiveMax: 1200, maxPages: 60, warmPages: 30 },
  { key: "poly", channel: "PolyBeats_Bot", archiveMax: 800, maxPages: 40, warmPages: 20 }
];

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

function cleanPolyText(text) {
  return text
    .replace(/订阅BlockBeats会员可查看完整预测市场新闻内容[\s\S]*$/i, "")
    .replace(/让你更早看到未来，关注[\s\S]*$/i, "")
    .replace(/See tomorrow, today\.[\s\S]*$/i, "")
    .trim();
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
      body: truncate(lines.filter((_, i) => i !== idx).join(" ").replace(/^Tradfin:\s*/i, ""), 300)
    };
  }
  return {
    title: truncate(lines[0] || "", key === "poly" ? 130 : 110),
    body: truncate(lines.slice(1).join(" "), key === "poly" ? 520 : 280)
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
  const now = Date.now();
  const items = [];
  for (let i = 0; i < starts.length; i++) {
    const id = starts[i][1];
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.indexOf("</main>", start);
    const block = html.slice(start, end > start ? end : undefined);
    const textHtml = block.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "";
    let text = textFromHtml(textHtml);
    if (cfg.key === "poly") text = cleanPolyText(text);
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
  return items
    .sort((a, b) => Number(b.id) - Number(a.id));
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 tradexyz-board/1.0"
      }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readTelegramHtml(cfg) {
  if (process.env.TG_HTML_DIR !== "0") {
    try {
      return await readFile(`tg-${cfg.channel}.html`, "utf8");
    } catch {
      // Fall back to the live public Telegram page.
    }
  }
  return await fetchText(`https://t.me/s/${cfg.channel}`);
}

async function readTelegramPage(cfg, before) {
  if (!before) return await readTelegramHtml(cfg);
  return await fetchText(`https://t.me/s/${cfg.channel}?before=${before}`);
}

function mergeArchive(fetched, previous, cfg) {
  const cutoff = Date.now() - RETAIN_MS;
  const map = new Map();
  for (const item of [...(previous || []), ...(fetched || [])]) {
    if (!item || !item.id) continue;
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

async function fetchChannelArchive(cfg, previous) {
  const previousIds = new Set((previous || []).map(x => String(x.id || "")).filter(Boolean));
  const cutoff = Date.now() - RETAIN_MS;
  const fetched = [];
  let before = null;
  let overlapped = false;
  for (let page = 0; page < cfg.maxPages; page++) {
    const html = await readTelegramPage(cfg, before);
    const pageItems = parseTelegramHtml(html, cfg, previous);
    if (!pageItems.length) break;
    fetched.push(...pageItems);
    if (pageItems.some(x => previousIds.has(String(x.id)))) overlapped = true;
    const oldest = pageItems[pageItems.length - 1];
    const oldestTs = Number(oldest?.ts || 0);
    const warmEnough = previousIds.size > 0 && overlapped && page + 1 >= 2;
    const initialWarmEnough = previousIds.size === 0 && page + 1 >= cfg.warmPages;
    if ((Number.isFinite(oldestTs) && oldestTs > 0 && oldestTs < cutoff) || warmEnough || initialWarmEnough) break;
    const nextBefore = Number(oldest?.id || 0);
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;
  }
  return mergeArchive(fetched, previous, cfg);
}

async function readExisting() {
  try {
    return JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    return { channels: {} };
  }
}

async function main() {
  const existing = await readExisting();
  const channels = {};
  for (const cfg of CHANNELS) {
    const prev = existing.channels?.[cfg.key]?.items || [];
    try {
      const items = await fetchChannelArchive(cfg, prev);
      if (!items.length && prev.length) {
        channels[cfg.key] = { channel: cfg.channel, items: prev, error: "empty scrape kept previous" };
      } else {
        channels[cfg.key] = { channel: cfg.channel, items };
      }
    } catch (error) {
      channels[cfg.key] = { channel: cfg.channel, items: prev, error: error.message };
    }
  }
  await writeFile(OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: "telegram-public-html",
    retentionDays: RETAIN_DAYS,
    channels
  }, null, 2) + "\n", "utf8");
  console.log(Object.entries(channels).map(([k, v]) => `${k}:${v.items.length}${v.error ? `(${v.error})` : ""}`).join(" "));
}

await main();
