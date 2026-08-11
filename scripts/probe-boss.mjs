#!/usr/bin/env node
// 诊断：点击继续沟通后，输出发送按钮的各级父容器，找到包含 BOSS 姓名+公司的头部
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;
const URL =
  process.argv[2] ||
  "https://www.zhipin.com/job_detail/5c62d4a82667f4bc0nJ509i8FVRT.html";

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

  await call("Page.navigate", { url: URL });
  await new Promise((r) => setTimeout(r, 5000));
  await evalIn(`(() => {
    const el = Array.from(document.querySelectorAll("a,button,span,div"))
      .find((e) => /立即沟通|继续沟通/.test(e.textContent || "") && e.children.length === 0);
    if (el) el.click();
  })()`);
  await new Promise((r) => setTimeout(r, 4000));

  const expr = `(() => {
    const send = document.querySelector(".btn-send");
    if (!send) return "no send btn";
    const chain = [];
    let el = send;
    for (let i = 0; i < 6 && el; i++) {
      chain.push({
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 70),
        text: el.innerText.replace(/\\s+/g, " ").trim().slice(0, 160),
      });
      el = el.parentElement;
    }
    return JSON.stringify(chain);
  })()`;
  console.log(await evalIn(expr));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
