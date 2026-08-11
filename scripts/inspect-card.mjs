#!/usr/bin/env node
// 诊断用：输出第一个岗位卡片的原始 HTML，用于确认薪资等字段是否有可读属性
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
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
          reject(new Error("timeout " + method));
        }
      }, 25000);
    });
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  const expr = `(() => {
    const a = document.querySelector("a[href*='/job_detail/']");
    if (!a) return "no anchor";
    const card =
      a.closest("li") ||
      a.closest("[class*='job-card']") ||
      a.closest("[class*='job-list'] > *") ||
      a.parentElement;
    return JSON.stringify({
      cardClass: card.className,
      salaryEls: Array.from(card.querySelectorAll("[class*='salary'], [class*='price'], [class*='money']")).map((e) => ({
        cls: e.className,
        text: e.innerText.slice(0, 60),
        data: Object.fromEntries(Array.from(e.attributes).map((x) => [x.name, x.value])),
      })),
      html: card.outerHTML.slice(0, 3000),
    });
  })()`;

  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  console.log(
    r.result && r.result.result && r.result.result.value
      ? r.result.result.value
      : JSON.stringify(r).slice(0, 1500)
  );
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
