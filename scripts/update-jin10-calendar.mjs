import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://cdn-rili.jin10.com/web_data";
const OUT = "jin10-calendar.json";

function beijingDateKey(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ms));
  const out = {};
  parts.forEach(p => { if (p.type !== "literal") out[p.type] = p.value; });
  return `${out.year}-${out.month}-${out.day}`;
}

function dateKeyToMs(key) {
  const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0) : Date.now();
}

function addDaysKey(key, n) {
  return beijingDateKey(dateKeyToMs(key) + n * 24 * 60 * 60 * 1000);
}

function isoWeekInfo(ms) {
  const d = new Date(dateKeyToMs(beijingDateKey(ms)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - first) / 86400000) + 1) / 7);
  return { year, week };
}

function collectRows(node, kind, dateHint, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(x => collectRows(x, kind, dateHint, out));
    return;
  }
  if (typeof node !== "object") return;
  const rowLike = node.indicator_name || node.event_content || node.exchange_name || node.name || node.title;
  if (rowLike) {
    out.push({ __kind: kind, __dateHint: dateHint || "", ...node });
    return;
  }
  Object.keys(node).forEach(k => {
    const nextDate = /^20\d{2}-\d{2}-\d{2}$/.test(k) ? k : dateHint;
    collectRows(node[k], kind, nextDate, out);
  });
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "tradexyz-board/1.0" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function inferCountry(title) {
  const m = String(title || "").match(/美国|中国|日本|欧元区|德国|英国|法国|瑞士|加拿大|澳大利亚|韩国|新西兰/);
  return m ? m[0] : "";
}

async function scrapePublicWeekRows() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return [];
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto("https://rili.jin10.com/", { waitUntil: "networkidle", timeout: 45000 });
    const text = await page.locator("body").innerText({ timeout: 15000 });
    const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const start = text.match(/(20\d{2})年(\d{2})月(\d{2})日-\d{4}年\d{2}月\d{2}日/) ||
      text.match(/(20\d{2})-(\d{2})-(\d{2})/);
    const weekStart = start ? `${start[1]}-${start[2]}-${start[3]}` : beijingDateKey();
    const dayMap = { "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6 };
    const rows = [];
    let currentDay = null;
    for (let i = 0; i < lines.length; i++) {
      const day = lines[i].match(/^周([一二三四五六日])$/);
      if (day) {
        currentDay = dayMap[day[1]];
        continue;
      }
      if (currentDay == null || !/^\d{1,2}:\d{2}$/.test(lines[i])) continue;
      const title = lines[i + 1] || "";
      if (!title || /^周[一二三四五六日]$|^\/\s*[A-Za-z]+/.test(title)) continue;
      const date = addDaysKey(weekStart, currentDay);
      rows.push({
        __kind: "event",
        __dateHint: date,
        event_time: `${date} ${lines[i]}`,
        event_content: title,
        country: inferCountry(title),
        star: 3,
        source: "jin10-public-week"
      });
    }
    return rows;
  } finally {
    await browser.close();
  }
}

async function main() {
  const today = beijingDateKey();
  const endKey = addDaysKey(today, 13);
  const weeks = [isoWeekInfo(dateKeyToMs(today)), isoWeekInfo(dateKeyToMs(endKey))]
    .filter((w, i, arr) => arr.findIndex(x => x.year === w.year && x.week === w.week) === i);
  const rows = [];
  const errors = [];

  for (const w of weeks) {
    for (const [file, kind] of [["economics.json", "economics"], ["event.json", "event"], ["holiday.json", "holiday"]]) {
      const url = `${BASE}/${w.year}/week/${w.week}/${file}`;
      try {
        collectRows(await fetchJson(url), kind, "", rows);
      } catch (error) {
        errors.push({ url, message: error.message });
      }
    }
  }

  if (!rows.length) {
    try {
      rows.push(...await scrapePublicWeekRows());
    } catch (error) {
      errors.push({ url: "https://rili.jin10.com/", message: `public scrape failed: ${error.message}` });
    }
  }

  if (rows.length < 20) {
    try {
      const current = JSON.parse(await readFile(OUT, "utf8"));
      if (Array.isArray(current.rows) && current.rows.length >= 20) {
        console.log(`Keeping existing ${OUT}: new scrape only returned ${rows.length} rows`);
        return;
      }
    } catch {
      // No usable local snapshot; write the new result below so the failure is visible.
    }
  }

  await writeFile(OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    beijingDate: today,
    range: { start: today, end: endKey },
    weeks,
    rows,
    errors
  }, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT}: ${rows.length} rows, ${errors.length} errors`);
}

await main();
