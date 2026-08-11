#!/usr/bin/env node
// 诊断：打开岗位详情 → 点击"立即沟通" → 输出聊天输入框结构
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

  // 找"立即沟通"按钮
  const btnExpr = `(() => {
    const btns = Array.from(document.querySelectorAll("button,a,div,span"))
      .filter((e) => /立即沟通/.test(e.textContent || "") && e.children.length === 0)
      .map((e) => ({ tag: e.tagName, cls: e.className, text: e.textContent.trim().slice(0, 20) }));
    return JSON.stringify(btns.slice(0, 10));
  })()`;
  console.log("立即沟通按钮:");
  console.log(await evalIn(btnExpr));

  // 点击第一个
  const clickExpr = `(() => {
    const el = Array.from(document.querySelectorAll("button,a,div,span"))
      .find((e) => /立即沟通/.test(e.textContent || "") && e.children.length === 0);
    if (!el) return "未找到";
    el.click();
    return "已点击";
  })()`;
  console.log(await evalIn(clickExpr));
  await new Promise((r) => setTimeout(r, 4000));

  const inputExpr = `(() => {
    const inputs = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],input[type='text'],input:not([type])"));
    return JSON.stringify({
      url: location.href,
      inputs: inputs.map((e) => ({
        tag: e.tagName,
        cls: typeof e.className === "string" ? e.className.slice(0, 80) : "",
        ph: e.getAttribute("placeholder") || "",
        ce: e.getAttribute("contenteditable"),
      })).slice(0, 15),
      bodyTail: document.body ? document.body.innerText.slice(-800) : "",
    });
  })()`;
  console.log("输入框探测:");
  console.log(await evalIn(inputExpr));

  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
