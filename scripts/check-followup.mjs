#!/usr/bin/env node
// 跟进判断：列表筛出[送达]+昨天及以前的候选 → 逐个进会话数 boss 消息
// boss 从未发过消息 → 待跟进；boss 发过消息 → 已有一轮沟通，跳过
// 用法：node check-followup.mjs [数量，默认10]
const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

async function main() {
  const limit = parseInt(process.argv[2] || "10", 10);
  const dumpItems = process.argv.includes("--dump");
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
  const loadChat = async () => {
    await call("Page.navigate", { url: "https://www.zhipin.com/web/geek/chat" });
    // 轮询等待列表加载完成（出现会话条目结构），最长 10 秒
    for (let i = 0; i < 13; i++) {
      const v = await evalIn(`(() => {
        return !!document.querySelector(".friend-content");
      })()`);
      if (v === true) return;
      await new Promise((r) => setTimeout(r, 800));
    }
  };

  // 第 1 步：列表级筛选（[送达] + 昨天及以前）
  await loadChat();
  const body =
    (await evalIn(`(() => document.body ? document.body.innerText : "")()`)) ||
    "";
  const lines = body.split("\n").map((t) => t.trim()).filter(Boolean);
  const start = lines.indexOf("更多");
  const data = start >= 0 ? lines.slice(start + 1) : lines;
  const timeRe = /^(昨天|前天|今天|刚刚|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|星期[一二三四五六日天]|\d+分钟前|\d+小时前|\d+天前)$/;
  const statusRe = /^\[[^\]]+\]$/;
  const oldTimeRe = /^(昨天|前天|\d{1,2}月\d{1,2}日|星期[一二三四五六日天]|\d+天前)$/;
  const convos = [];
  let cur = null;
  for (const line of data) {
    if (timeRe.test(line)) {
      cur = { time: line, identity: "", status: "" };
      convos.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.identity) {
      cur.identity = line;
      continue;
    }
    if (statusRe.test(line) && !cur.status) {
      cur.status = line;
      continue;
    }
  }
  const candidates = convos.filter(
    (c) => c.status === "[送达]" && oldTimeRe.test(c.time)
  );
  console.log("列表级候选（[送达]+昨天及以前）：" + candidates.length + " 条，检查前 " + Math.min(limit, candidates.length) + " 条");

  // 第 2 步：逐个进会话数 boss 消息
  const followups = [];
  const skipped = [];
  // 真实鼠标点击：找到会话条目，按下+松开（部分 UI 只响应真实鼠标事件）
  const clickItem = async (kw) => {
    await call("Page.bringToFront");
    await new Promise((r) => setTimeout(r, 200));
    const info = await evalIn(`(async () => {
      // 会话条目是 li：优先找包含关键词的可见 li
      const lis = Array.from(document.querySelectorAll("li"))
        .filter(
          (e) =>
            (e.textContent || "").replace(/\\s+/g, "").includes(${JSON.stringify(kw)}) &&
            e.offsetParent !== null
        )
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const el = lis[0];
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 200));
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return null;
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (!info) return "未找到";
    const { x, y } = JSON.parse(info);
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return "ok";
  };
  for (const c of candidates.slice(0, limit)) {
    const kw = c.identity.slice(0, 4);
    console.log("点击：" + (await clickItem(kw)));
    let s = { ok: false, total: 0, boss: 0, mine: 0, header: "" };
    for (let i = 0; i < 12; i++) {
      s = JSON.parse(
        await evalIn(`(() => {
          const conv = document.querySelector(".chat-conversation");
          if (!conv) return JSON.stringify({ ok: false, header: "no-conv" });
          const items = Array.from(conv.querySelectorAll("li.message-item"));
          const isSystem = (e) => {
            const cls = typeof e.className === "string" ? e.className : "";
            const txt = e.innerText || "";
            if (cls.includes("item-system")) return true;
            return /你与该职位竞争者PK情况|查看详细分析|附件简历|简历请求已发送|对方已同意|对方已查看|正在与Boss|您正在与|简历已发送给Boss|已拒绝向对方发送简历|交换联系方式/.test(txt);
          };
          const mine = items.filter(
            (e) =>
              (typeof e.className === "string" ? e.className : "").includes("item-myself") &&
              !isSystem(e)
          ).length;
          const boss = items.filter((e) => !isSystem(e)).length - mine;
          return JSON.stringify({
            ok: true,
            total: items.length,
            boss,
            mine,
            header: conv.innerText.replace(/\\s+/g, " ").slice(0, 60),
          });
        })()`)
      );
      const kwHit = s.header && s.header.includes(kw.replace(/ /g, ""));
      if (s.ok && s.total > 0 && kwHit) break;
      if (i % 3 === 2) {
        await clickItem(kw);
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    if (!s.ok) {
      skipped.push({ identity: c.identity, reason: "会话打开失败" });
    } else if (s.boss > 0) {
      skipped.push({ identity: c.identity, reason: "boss 已发过消息（" + s.boss + " 条）" });
    } else {
      followups.push({ identity: c.identity, mine: s.mine });
    }
    console.log(
      (s.boss > 0 ? "⏭ " : "✅ ") +
        c.identity +
        " | 我方 " + s.mine + " 条 / boss " + s.boss + " 条 | 头部: " + (s.header || "无")
    );
    if (dumpItems) {
      const items = await evalIn(`(() => {
        const conv = document.querySelector(".chat-conversation");
        if (!conv) return "[]";
        return JSON.stringify(
          Array.from(conv.querySelectorAll("li.message-item")).map((e) => ({
            cls: (typeof e.className === "string" ? e.className : "").slice(0, 40),
            text: (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40),
          }))
        );
      })()`);
      console.log("  └ " + items);
    }
  }

  console.log("\n===== 待跟进（boss 从未发消息）=====");
  followups.forEach((f, i) => console.log((i + 1) + ". " + f.identity + "（我方已发 " + f.mine + " 条）"));
  console.log("\n===== 跳过 =====");
  skipped.forEach((s, i) => console.log((i + 1) + ". " + s.identity + " —— " + s.reason));
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
