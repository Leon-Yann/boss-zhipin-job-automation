#!/usr/bin/env node
// 提取消息列表中"状态[送达] 且 时间为昨天及之前"的会话（未读候选）
// 用法：node check-unread.mjs [数量，默认10]
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const limit = parseInt(process.argv[2] || "10", 10);
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

  await call("Page.navigate", { url: "https://www.zhipin.com/web/geek/chat" });
  await new Promise((r) => setTimeout(r, 6000));
  const body = (await evalIn(
    `(() => document.body ? document.body.innerText : "")()`
  )) || "";

  const lines = body.split("\n").map((t) => t.trim()).filter(Boolean);
  const start = lines.indexOf("更多");
  const data = start >= 0 ? lines.slice(start + 1) : lines;
  const timeRe = /^(昨天|前天|今天|刚刚|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|星期[一二三四五六日天]|\d+分钟前|\d+小时前|\d+天前)$/;
  const statusRe = /^\[[^\]]+\]$/;
  const oldTimeRe = /^(昨天|前天|\d{1,2}月\d{1,2}日|星期[一二三四五六日天]|\d+天前)$/;

  const convos = [];
  let cur = null;
  for (const line of data) {
    if (timeRe.test(line)) {
      cur = { time: line, identity: "", status: "" };
      convos.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.identity) {
      cur.identity = line;
      continue;
    }
    if (statusRe.test(line) && !cur.status) {
      cur.status = line;
      continue;
    }
  }

  const unread = convos.filter(
    (c) => c.status === "[送达]" && oldTimeRe.test(c.time)
  );
  console.log(
    "未读候选（[送达] + 昨天及之前）：共 " +
      unread.length +
      " 条，取前 " +
      Math.min(limit, unread.length) +
      " 条："
  );
  unread.slice(0, limit).forEach((c, i) => {
    console.log((i + 1) + ". [" + c.time + "] " + c.identity);
  });
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
