#!/usr/bin/env node
// 诊断2：点击立即沟通后，深挖聊天面板结构与输入框
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

const URL = process.argv[2] || "https://www.zhipin.com/job_detail/5c62d4a82667f4bc0nJ509i8FVRT.html";

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
    if (r.result && r.result.exceptionDetails)
      throw new Error("页面出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await call("Page.navigate", { url: URL });
  await new Promise((r) => setTimeout(r, 5000));
  const clickExpr = `(() => {
    const els = Array.from(document.querySelectorAll("a,button,span,div"))
      .filter((e) => /立即沟通|继续沟通/.test(e.textContent || "") && e.children.length === 0);
    const found = els.map((e) => e.textContent.trim().slice(0, 10) + "@" + e.className);
    if (!els.length) return "未找到:" + JSON.stringify(found);
    els[0].click();
    return "已点击:" + JSON.stringify(found);
  })()`;
  console.log(await evalIn(clickExpr));
  await new Promise((r) => setTimeout(r, 4000));

  const expr = `(() => {
    const sendBtn = Array.from(document.querySelectorAll("button,a,div,span"))
      .find((e) => e.textContent.trim() === "发送" && e.children.length === 0);
    const panel = sendBtn
      ? (sendBtn.closest("[class*='chat']") || sendBtn.closest(".dialog-wrap") || sendBtn.parentElement.parentElement)
      : null;
    const editable = Array.from(document.querySelectorAll("[contenteditable]")).map((e) => ({
      cls: (typeof e.className === "string" ? e.className : "").slice(0, 80),
      ce: e.getAttribute("contenteditable"),
      ph: e.getAttribute("placeholder") || "",
      text: e.innerText.slice(0, 40),
    }));
    const areas = Array.from(document.querySelectorAll("textarea")).map((e) => ({
      cls: (typeof e.className === "string" ? e.className : "").slice(0, 80),
      ph: e.getAttribute("placeholder") || "",
      hidden: e.offsetParent === null,
    }));
    return JSON.stringify({
      sendBtnCls: sendBtn ? sendBtn.className : null,
      panelCls: panel ? panel.className : null,
      editable,
      areas,
      panelHtml: panel ? panel.outerHTML.slice(0, 1800) : "无面板",
    });
  })()`;
  console.log(await evalIn(expr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
