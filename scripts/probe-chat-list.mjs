#!/usr/bin/env node
// 诊断：消息列表页 DOM 结构（会话条目的 class 与文本）
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

  const expr = `(() => {
    const cands = Array.from(
      document.querySelectorAll("li, [class*='chat-item'], [class*='session'], [class*='conversation']")
    );
    return JSON.stringify(
      cands
        .map((e) => ({
          tag: e.tagName,
          cls: (typeof e.className === "string" ? e.className : "").slice(0, 60),
          text: e.innerText.replace(/\\s+/g, " ").trim().slice(0, 90),
        }))
        .slice(0, 25)
    );
  })()`;
  console.log(await evalIn(expr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
