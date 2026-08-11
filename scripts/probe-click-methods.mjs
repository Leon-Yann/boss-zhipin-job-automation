#!/usr/bin/env node
// 诊断：对比多种点击方式（真实鼠标序列 / 合成 click）能否打开会话
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const keyword = process.argv[2] || "周瑶瑶";
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
  const header = async () =>
    await evalIn(`(() => {
      const conv = document.querySelector(".chat-conversation");
      return conv ? conv.innerText.replace(/\\s+/g, " ").slice(0, 60) : "no-conv";
    })()`);

  const coords = async () => {
    const v = await evalIn(`(() => {
      const lis = Array.from(document.querySelectorAll("li"))
        .filter(
          (e) =>
            (e.textContent || "").replace(/\\s+/g, "").includes(${JSON.stringify(keyword)}) &&
            e.offsetParent !== null
        )
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const el = lis[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    return v ? JSON.parse(v) : null;
  };

  await call("Page.navigate", { url: "https://www.zhipin.com/web/geek/chat" });
  await new Promise((r) => setTimeout(r, 7000));
  console.log("初始头部：" + (await header()));

  // 方法1：mouseMoved + mousePressed + mouseReleased
  let c = await coords();
  if (c) {
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    await new Promise((r) => setTimeout(r, 300));
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 150));
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 3000));
    console.log("方法1(真实鼠标序列)后头部：" + (await header()));
  }

  // 方法2：合成 click 点击 li
  const clicked2 = await evalIn(`(() => {
    const lis = Array.from(document.querySelectorAll("li"))
      .filter((e) => (e.textContent || "").replace(/\\s+/g, "").includes(${JSON.stringify(keyword)}) && e.offsetParent !== null)
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    const el = lis[0];
    if (!el) return "无";
    el.click();
    return "已click";
  })()`);
  console.log("方法2：" + clicked2);
  await new Promise((r) => setTimeout(r, 3000));
  console.log("方法2(合成click)后头部：" + (await header()));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
