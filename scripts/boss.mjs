#!/usr/bin/env node
// BOSS直聘 CDP 驱动脚本 v0.1（测试模式专用）
// 依赖：调试版 Chrome 运行中（--remote-debugging-port=9222）
// 用法：
//   node boss.mjs jobs [--query 电商运营] [--city 101010100]
//   node boss.mjs jd <岗位详情URL>
//   node boss.mjs chat
//   node boss.mjs favorites [--page 1]
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTabs() {
  const res = await fetch(`${CDP}/json/list`);
  return await res.json();
}

async function getZhipinTab() {
  const tabs = await getTabs();
  return (
    tabs.find((t) => t.type === "page" && t.url && t.url.includes("zhipin.com")) ||
    null
  );
}

async function withTab(tab, fn) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 0;
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
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, 30000);
    });
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

async function evalIn(call, expression) {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(
      "页面执行出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 500)
    );
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function navigate(call, url) {
  await call("Page.navigate", { url });
  await sleep(4000);
}

// 通用抽取：找岗位详情链接，向上找卡片容器，取文本
const EXTRACT_JOBS = `(() => {
  const anchors = Array.from(document.querySelectorAll('a[href*="/job_detail/"]'));
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const href = a.href.split('?')[0];
    if (seen.has(href)) continue;
    seen.add(href);
    const card =
      a.closest('li') ||
      a.closest('[class*="job-card"]') ||
      a.closest('[class*="job-list"] > *') ||
      a.closest('div');
    const text = (card ? card.innerText : a.innerText).replace(/\\s+/g, ' ').trim();
    out.push({ href, text: text.slice(0, 600) });
  }
  return JSON.stringify({ count: out.length, items: out, url: location.href });
})()`;

const EXTRACT_JD = `(() => {
  const sel = document.querySelector(
    '.job-sec-text, [class*="job-detail"] .job-sec-text, [class*="job-sec"]'
  );
  let text = sel ? sel.innerText : "";
  if (!text) text = document.body.innerText;
  const body = document.body ? document.body.innerText : "";
  const salaryMatch = body.match(
    /(\\d{2,3}\\s*[-~—]\\s*\\d{2,3}K(?:\\s*·\\s*\\d{1,2}薪)?)/
  );
  const onlineEl = document.querySelector(".boss-online-tag");
  const ciIdx = body.indexOf("公司基本信息");
  const companyInfo =
    ciIdx >= 0
      ? body.slice(ciIdx + 6, ciIdx + 180).replace(/\\s+/g, " ").trim()
      : null;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    jd: text.replace(/\\s+/g, " ").slice(0, 4000),
    salary: salaryMatch ? salaryMatch[1].replace(/\\s+/g, "") : null,
    bossOnline: onlineEl ? onlineEl.innerText.trim().slice(0, 30) : null,
    companyInfo,
  });
})()`;

const EXTRACT_CHAT = `(() => {
  return JSON.stringify({
    url: location.href,
    body: document.body ? document.body.innerText.slice(0, 6000) : "",
  });
})()`;

async function cmdJobs(args) {
  const cfg = loadConfig();
  const query = args.query || cfg.search_keywords[0];
  const city = args.city || cfg.city_code;
  const url = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(
    query
  )}&city=${city}`;
  const tab = await getZhipinTab();
  if (!tab) {
    throw new Error("未找到 BOSS 直聘标签页，请先在调试版 Chrome 中打开 zhipin.com");
  }
  await withTab(tab, async (call) => {
    await navigate(call, url);
    await sleep(3000);
    const raw = await evalIn(call, EXTRACT_JOBS);
    console.log(JSON.stringify(JSON.parse(raw), null, 1));
  });
}

async function cmdJd(args) {
  const url = args._[0];
  if (!url || !url.includes("zhipin.com")) {
    throw new Error("用法：node boss.mjs jd <岗位详情URL>");
  }
  const tab = await getZhipinTab();
  if (!tab) {
    throw new Error("未找到 BOSS 直聘标签页，请先在调试版 Chrome 中打开 zhipin.com");
  }
  await withTab(tab, async (call) => {
    await navigate(call, url);
    await sleep(2500);
    const raw = await evalIn(call, EXTRACT_JD);
    console.log(JSON.stringify(JSON.parse(raw), null, 1));
  });
}

async function cmdChat() {
  const url = "https://www.zhipin.com/web/geek/chat";
  const tab = await getZhipinTab();
  if (!tab) {
    throw new Error("未找到 BOSS 直聘标签页，请先在调试版 Chrome 中打开 zhipin.com");
  }
  await withTab(tab, async (call) => {
    await navigate(call, url);
    await sleep(5000);
    const raw = await evalIn(call, EXTRACT_CHAT);
    console.log(JSON.stringify(JSON.parse(raw), null, 1));
  });
}

async function cmdFavorites(args) {
  const page = args.page || 1;
  const url = `https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=${page}&tag=4`;
  const tab = await getZhipinTab();
  if (!tab) {
    throw new Error("未找到 BOSS 直聘标签页，请先在调试版 Chrome 中打开 zhipin.com");
  }
  await withTab(tab, async (call) => {
    await navigate(call, url);
    await sleep(4000);
    const raw = await evalIn(call, EXTRACT_JOBS);
    console.log(JSON.stringify(JSON.parse(raw), null, 1));
  });
}

// 简易参数解析：--key value
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      if (typeof args[key] !== "boolean") i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

try {
  if (cmd === "jobs") await cmdJobs(args);
  else if (cmd === "jd") await cmdJd(args);
  else if (cmd === "chat") await cmdChat();
  else if (cmd === "favorites") await cmdFavorites(args);
  else {
    console.log("用法：node boss.mjs {jobs|jd|chat|favorites} [参数]");
    process.exit(1);
  }
} catch (e) {
  console.error("错误：" + e.message);
  process.exit(1);
}
