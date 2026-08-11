#!/usr/bin/env node
// 打开指定 BOSS 的会话，输出聊天头部与岗位链接
// 用法：node open-conversation.mjs <对方关键词>
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const keyword = process.argv[2] || "钛动";
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

  const clicked = await evalIn(`(() => {
    const el = Array.from(document.querySelectorAll("div,li,span,a"))
      .find((e) => e.textContent && e.textContent.includes(${JSON.stringify(keyword)}) && e.children.length === 0);
    if (!el) return "未找到";
    el.click();
    return "已点击";
  })()`);
  console.log("打开会话：" + clicked);
  await new Promise((r) => setTimeout(r, 4000));

  const expr = `(() => {
    const conv = document.querySelector(".chat-conversation");
    const jobLink = conv
      ? Array.from(conv.querySelectorAll("a[href*='job_detail']")).map((a) => a.href)
      : [];
    return JSON.stringify({
      header: conv ? conv.innerText.replace(/\\s+/g, " ").slice(0, 300) : null,
      jobLink: jobLink[0] || null,
    });
  })()`;
  console.log(await evalIn(expr));

  if (process.argv[3] === "--job") {
    const clickedJob = await evalIn(`(() => {
      const conv = document.querySelector(".chat-conversation");
      if (!conv) return "no-conv";
      const el = Array.from(conv.querySelectorAll("a,span,div,button"))
        .find((e) => {
          const t = (e.textContent || "").trim();
          return t === "查看职位" || (t.includes("查看职位") && t.length < 20);
        });
      if (!el) return "no-view-job";
      el.click();
      return "clicked";
    })()`);
    console.log("点击查看职位：" + clickedJob);
    await new Promise((r) => setTimeout(r, 5000));
    const jobExpr = `(() => {
      const sel = document.querySelector(
        ".job-sec-text, [class*='job-detail'] .job-sec-text, [class*='job-sec']"
      );
      const body = document.body ? document.body.innerText : "";
      const salaryMatch = body.match(
        /(\\d{1,3}\\s*[-~—]\\s*\\d{1,3}K(?:\\s*·\\s*\\d{1,2}薪)?)/
      );
      return JSON.stringify({
        url: location.href,
        title: document.title,
        salary: salaryMatch ? salaryMatch[1].replace(/\\s+/g, "") : null,
        jd: (sel ? sel.innerText : body).replace(/\\s+/g, " ").trim().slice(0, 2000),
      });
    })()`;
    console.log(await evalIn(jobExpr));
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
