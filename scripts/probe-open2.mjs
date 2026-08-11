#!/usr/bin/env node
// 诊断：打开指定会话后，输出会话面板的详细状态
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
  await new Promise((r) => setTimeout(r, 6000));
  const click = await evalIn(`(() => {
    const els = Array.from(document.querySelectorAll("div,li,span,a"))
      .filter((e) => e.textContent && e.textContent.includes(${JSON.stringify(keyword)}) && e.children.length === 0);
    if (!els.length) return "未找到:" + ${JSON.stringify(keyword)};
    els[0].click();
    const li = els[0].closest("li") || els[0].parentElement;
    if (li && li !== els[0]) li.click();
    return "已点击(" + els.length + ")";
  })()`);
  console.log("点击：" + click);
  await new Promise((r) => setTimeout(r, 5000));

  const expr = `(() => {
    const conv = document.querySelector(".chat-conversation");
    return JSON.stringify({
      href: location.href,
      convExists: !!conv,
      convHeader: conv ? conv.innerText.replace(/\\s+/g, " ").slice(0, 100) : null,
      msgItems: conv ? conv.querySelectorAll("li.message-item").length : -1,
      convHtml: conv ? conv.outerHTML.slice(0, 800) : "no-conv",
      allMsgClass: Array.from(document.querySelectorAll("[class*='message'],[class*='msg-item'],[class*='chat-body']"))
        .map((e) => (typeof e.className === "string" ? e.className : "").slice(0, 50))
        .slice(0, 15),
    });
  })()`;
  console.log(await evalIn(expr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
