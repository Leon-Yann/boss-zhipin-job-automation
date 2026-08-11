#!/usr/bin/env node
// 诊断：推荐流是否有"加载更多"按钮或滚动加载
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  let tab =
    tabs.find((t) => t.type === "page" && t.url && t.url.includes("zhipin.com")) ||
    tabs.find((t) => t.type === "page");
  if (!tab) {
    console.log("NO_TAB");
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
  const countCards = async () =>
    parseInt(
      await evalIn(`(() => {
        const anchors = Array.from(document.querySelectorAll("a[href*='/job_detail/']"));
        const seen = new Set();
        for (const a of anchors) {
          const href = a.href.split("?")[0];
          if (href.includes(".html")) seen.add(href);
        }
        return seen.size;
      })()`),
      10
    );

  await call("Page.navigate", { url: "https://www.zhipin.com/web/geek/jobs" });
  await new Promise((r) => setTimeout(r, 5000));
  const before = await countCards();
  const loadMore = await evalIn(`(() => {
    const els = Array.from(document.querySelectorAll("a,button,div,span"))
      .filter((e) => /加载更多|查看更多|下一页/.test(e.textContent || "") && e.offsetParent !== null)
      .map((e) => ({ t: e.textContent.trim().slice(0, 20), cls: (typeof e.className === "string" ? e.className : "").slice(0, 50) }));
    return JSON.stringify(els.slice(0, 5));
  })()`);
  console.log("加载前岗位数：" + before);
  console.log("加载更多元素：" + loadMore);

  // 滚动到底部看是否自动加载
  await evalIn(`(() => { window.scrollTo(0, document.body.scrollHeight); })()`);
  await new Promise((r) => setTimeout(r, 3000));
  await evalIn(`(() => { window.scrollTo(0, document.body.scrollHeight); })()`);
  await new Promise((r) => setTimeout(r, 3000));
  const after = await countCards();
  console.log("滚动到底后岗位数：" + after + "（" + (after - before) + " 新增）");
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
