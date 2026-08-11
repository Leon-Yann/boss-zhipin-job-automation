#!/usr/bin/env node
// 批量验证发送结果：一次性打开消息列表，按每条消息的前缀特征检查是否送达，并回写 CSV 状态
// 用法：node verify-sends.mjs
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const toField = (s) => '"' + String(s).replace(/"/g, '""') + '"';

async function main() {
  const cfg = loadConfig();
  const CSV_PATH = `${cfg.dataDir}/发送记录.csv`;
  const fs = await import("node:fs");
  if (!fs.existsSync(CSV_PATH)) {
    console.log("发送记录不存在");
    process.exit(0);
  }
  const raw = fs.readFileSync(CSV_PATH, "utf8").trim().split("\n");
  const rows = raw.map((l) => {
    const cols = parseCsvLine(l);
    const isOld = cols.length <= 4; // 旧格式：时间,URL,消息,状态
    return {
      time: cols[0],
      url: cols[1],
      msg: cols[2],
      boss: isOld ? "" : cols[3],
      status: isOld ? cols[3] : cols[4],
    };
  });
  const keys = rows.map((r) => ({
    // 优先按"姓名+公司"匹配（稳定）；老记录没有该字段时回退到消息前缀
    key: r.boss
      ? String(r.boss).replace(/\s+/g, "")
      : String(r.msg || "").replace(/\s+/g, "").slice(0, 14),
    row: r,
  }));
  console.log("待验证消息 " + keys.length + " 条");

  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find(
    (t) => t.type === "page" && t.url && t.url.includes("zhipin.com")
  );
  if (!tab) throw new Error("未找到 BOSS 直聘标签页");
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
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 一次性打开消息列表，取页面文本
  await call("Page.navigate", { url: "https://www.zhipin.com/web/geek/chat" });
  await new Promise((r) => setTimeout(r, 6000));
  const body = (await evalIn(
    `(() => document.body ? document.body.innerText : "")()`
  )) || "";

  let changed = false;
  for (const k of keys) {
    const found = body.includes(k.key);
    const newStatus = found ? "已送达确认" : "未找到";
    console.log((found ? "✅ " : "❌ ") + newStatus + " | " + k.key + "…");
    if (k.row.status !== newStatus) {
      k.row.status = newStatus;
      changed = true;
    }
  }
  if (changed) {
    const out =
      rows
        .map((r) =>
          [
            toField(r.time),
            toField(r.url),
            toField(r.msg),
            toField(r.boss || ""),
            toField(r.status),
          ].join(",")
        )
        .join("\n") + "\n";
    fs.writeFileSync(CSV_PATH, out);
    console.log("发送记录状态已更新");
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
