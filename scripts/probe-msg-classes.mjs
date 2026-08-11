#!/usr/bin/env node
// 诊断：列出某会话内所有 li.message-item 的类名与文本，区分我方/对方/系统消息
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const keyword = process.argv[2] || "泡泡玛特";
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
  await new Promise((r) => setTimeout(r, 7000));
  const kw2 = keyword.split("").slice(0, 2).join("");
  const clickItem = async () => {
    await call("Page.bringToFront");
    await new Promise((r) => setTimeout(r, 400));
    const c = await evalIn(`(async () => {
      const lis = Array.from(document.querySelectorAll("li"))
        .filter((e) => (e.textContent || "").replace(/\\s+/g, "").includes(${JSON.stringify(keyword)}) && e.offsetParent !== null)
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const el = lis[0];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 400));
      const b = el.getBoundingClientRect();
      if (!b || b.width === 0) return null;
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    })()`);
    if (!c) return false;
    const { x, y } = JSON.parse(c);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return true;
  };
  for (let i = 0; i < 12; i++) {
    if (i % 3 === 0) await clickItem();
    const h = await evalIn(`(() => {
      const conv = document.querySelector(".chat-conversation");
      return conv ? conv.innerText.replace(/\\s+/g, " ").slice(0, 60) : "";
    })()`);
    if (h && h.includes(kw2)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const expr = `(() => {
    const conv = document.querySelector(".chat-conversation");
    if (!conv) return "no-conv";
    const items = Array.from(conv.querySelectorAll("li.message-item"));
    return JSON.stringify(
      items.map((e) => ({
        cls: (typeof e.className === "string" ? e.className : "").slice(0, 60),
        text: (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 45),
      }))
    );
  })()`;
  console.log(await evalIn(expr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
