#!/usr/bin/env node
// 诊断：对比某来源第 1 页与第 2 页的岗位，确认翻页机制是否生效
// 用法：node probe-pagination.mjs <来源 search|favorites|recommend> [关键词]
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const cfg = loadConfig();
  const source = process.argv[2] || "search";
  const query = process.argv[3] || cfg.search_keywords[0];
  let tabs = await (await fetch(`${CDP}/json/list`)).json();
  let tab = tabs.find(
    (t) => t.type === "page" && t.url && t.url.includes("zhipin.com")
  );
  if (!tab) {
    // 没有 BOSS 直聘标签页时，退而求其次用任意页面标签页（脚本会逐页导航到目标页）
    tab = tabs.find((t) => t.type === "page");
  }
  if (!tab) {
    console.log("NO_ZHIPIN_TAB");
    process.exit(0);
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("timeout"));
        }
      }, 30000);
    });
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const evalIn = async (expression) => {
    const r = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const extract = async () => {
    const v = await evalIn(`(() => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/job_detail/']"));
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const href = a.href.split("?")[0];
        if (seen.has(href) || !href.includes(".html")) continue;
        seen.add(href);
        const card =
          a.closest("li") ||
          a.closest("[class*='job-card']") ||
          a.closest("[class*='job-list'] > *") ||
          a.closest("div");
        const text = (card ? card.innerText : a.innerText).replace(/\\s+/g, " ").trim();
        out.push({ href, text: text.slice(0, 60) });
      }
      return JSON.stringify({ url: location.href, count: out.length, items: out });
    })()`);
    return JSON.parse(v);
  };

  const urls = {
    search: (p) =>
      `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(query)}&city=${cfg.city_code}&page=${p}`,
    favorites: (p) =>
      `https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=${p}&tag=4`,
    recommend: (p) => `https://www.zhipin.com/web/geek/jobs?page=${p}`,
  };

  const pages = [];
  for (let p = 1; p <= 2; p++) {
    const u = urls[source](p);
    await call("Page.navigate", { url: u });
    await new Promise((r) => setTimeout(r, 5000));
    const d = await extract();
    pages.push(d);
    console.log(
      "第 " + p + " 页 | " + d.url.slice(0, 90) + " | 岗位数 " + d.count
    );
    console.log("  前 5 条：" + d.items.slice(0, 5).map((i) => i.text.slice(0, 30)).join(" / "));
  }
  if (pages.length === 2) {
    const hrefs1 = new Set(pages[0].items.map((i) => i.href));
    const hrefs2 = new Set(pages[1].items.map((i) => i.href));
    const overlap = [...hrefs1].filter((h) => hrefs2.has(h)).length;
    console.log("两页重叠岗位数：" + overlap + "（0 = 翻页有效且无重复；>0 = 存在跨页重复）");
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
