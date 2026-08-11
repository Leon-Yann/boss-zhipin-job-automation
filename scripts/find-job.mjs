#!/usr/bin/env node
// 按关键词搜索岗位并输出匹配公司的岗位链接与 JD
// 用法：node find-job.mjs <关键词> [公司关键词]
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const cfg = loadConfig();
  const query = process.argv[2] || cfg.search_keywords[0];
  const companyKw = process.argv[3] || "";
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find(
    (t) => t.type === "page" && t.url && t.url.includes("zhipin.com")
  );
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

  const searchUrl =
    "https://www.zhipin.com/web/geek/job?query=" +
    encodeURIComponent(query) +
    "&city=" + cfg.city_code;
  await call("Page.navigate", { url: searchUrl });
  await new Promise((r) => setTimeout(r, 5000));

  const cardsExpr = `(() => {
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
      out.push({ href, text: text.slice(0, 300) });
    }
    return JSON.stringify(out);
  })()`;
  const cards = JSON.parse((await evalIn(cardsExpr)) || "[]");
  const companyCards = companyKw
    ? cards.filter((c) => c.text.includes(companyKw))
    : cards;
  console.log("公司匹配卡片 " + companyCards.length + " 张：");
  companyCards.slice(0, 12).forEach((c, i) => console.log((i + 1) + ". " + c.text.slice(0, 130)));
  const hit =
    companyCards.find((c) => /AI|广告平台|CM/.test(c.text)) ||
    companyCards[0] ||
    cards[0];
  if (!hit) {
    console.log("未找到匹配岗位");
    console.log(
      "搜索结果前 15 条：\n" +
        cards
          .slice(0, 15)
          .map((c, i) => i + 1 + ". " + c.text.slice(0, 100))
          .join("\n")
    );
    process.exit(0);
  }
  console.log("命中：" + hit.text.slice(0, 120));

  await call("Page.navigate", { url: hit.href });
  await new Promise((r) => setTimeout(r, 4500));
  const jdExpr = `(() => {
    const sel = document.querySelector(
      ".job-sec-text, [class*='job-detail'] .job-sec-text, [class*='job-sec']"
    );
    const body = document.body ? document.body.innerText : "";
    const salaryMatch = body.match(
      /(\\d{1,3}\\s*[-~—]\\s*\\d{1,3}K(?:\\s*·\\s*\\d{1,2}薪)?)/
    );
    return JSON.stringify({
      url: location.href,
      title: document.title,
      salary: salaryMatch ? salaryMatch[1].replace(/\\s+/g, "") : null,
      jd: (sel ? sel.innerText : body).replace(/\\s+/g, " ").trim().slice(0, 2000),
    });
  })()`;
  console.log(await evalIn(jdExpr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
