#!/usr/bin/env node
// 发送开场白：打开岗位 → 点击立即沟通/继续沟通 → 聚焦输入框 → 输入消息 → 回车发送 → 校验
// 用法：node send.mjs --url <岗位URL> --msg "<开场白>" [--wait 秒] [--force] [--check-only]
// 数据路径与参数来自项目根目录 profile.yaml
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function getZhipinTab() {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  return (
    tabs.find(
      (t) => t.type === "page" && t.url && t.url.includes("zhipin.com")
    ) || null
  );
}

export async function sendOpening({ url, msg, wait = 0, company = "", force = false, checkOnly = false }) {
  const cfg = loadConfig();
  const LOG = `${cfg.dataDir}/发送记录.csv`;
  mkdirSync(cfg.dataDir, { recursive: true });
  if (!url) throw new Error("用法：node send.mjs --url <URL> --msg <消息>");
  if (!msg && !checkOnly) throw new Error("用法：node send.mjs --url <URL> --msg <消息>");
  // 发送前查重：同一岗位 URL 已发送过相同内容则跳过
  const fs0 = await import("node:fs");
  let dup = false;
  if (!checkOnly && fs0.existsSync(LOG)) {
    for (const l of fs0.readFileSync(LOG, "utf8").trim().split("\n")) {
      const cols = parseCsvLine(l);
      if (cols[1] === url && cols[2] === msg) {
        dup = true;
        break;
      }
    }
  }
  if (dup) {
    console.log("⚠️ 该岗位已发送过相同内容，跳过（防重复）");
    return { dup: true };
  }
  if (wait > 0) {
    console.log("等待 " + wait + " 秒（拟人节奏）...");
    await sleep(wait * 1000);
  }
  const tab = await getZhipinTab();
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
    if (r.result && r.result.exceptionDetails)
      throw new Error("页面出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const checkRisk = async () => {
    const s = await evalIn(`(() => {
      const body = document.body ? document.body.innerText : "";
      const hitText = /安全验证|请完成验证|滑块验证|拖动滑块|人机验证|验证码/.test(body);
      const hitEl = !!document.querySelector(
        "[class*='captcha'],[class*='verify'],[class*='slider'],[class*='geetest']"
      );
      return hitText || hitEl;
    })()`);
    return s === true;
  };

  console.log("打开岗位页...");
  await call("Page.navigate", { url });
  // 等待导航完成并校验当前 URL 与目标一致（防止页面未加载完就操作旧页面）
  let urlOk = false;
  for (let i = 0; i < 15 && !urlOk; i++) {
    await sleep(600);
    const cur = await evalIn(`(() => location.href)()`);
    urlOk = String(cur).split("?")[0] === url.split("?")[0];
  }
  if (!urlOk) {
    console.log("⚠️ 页面导航未到目标岗位，跳过（防错发）");
    ws.close();
    return { dup: false, risk: false, urlMismatch: true };
  }
  await sleep(200);
  await call("Page.bringToFront"); // 窗口置前，确保输入事件派发
  await sleep(150);

  // 读取按钮文本：区分"立即沟通"（未沟通过）与"继续沟通"（已沟通过）
  let btnText = "";
  for (let i = 0; i < 15 && !btnText; i++) {
    btnText = await evalIn(`(() => {
      const el = Array.from(document.querySelectorAll("a,button,span,div"))
        .find((e) => /立即沟通|继续沟通/.test(e.textContent || "") && e.children.length === 0);
      return el ? el.textContent.trim() : "";
    })()`);
    if (!btnText) await sleep(1000);
  }
  if (!btnText) throw new Error("未找到沟通按钮");
  if (btnText.includes("继续沟通")) {
    if (!force) {
      console.log("⚠️ 该岗位已沟通过（按钮为继续沟通），跳过（防重复打扰）");
      ws.close();
      return { dup: false, risk: false, contacted: true };
    }
    console.log("--force：已沟通岗位继续发送");
  }
  console.log("聊天按钮：" + btnText);
  if (checkOnly) {
    console.log(
      btnText.includes("继续沟通")
        ? "状态：已沟通过（继续沟通）"
        : "状态：未沟通（立即沟通）"
    );
    ws.close();
    return { dup: false, risk: false, contacted: btnText.includes("继续沟通"), checkOnly: true };
  }

  // 从岗位页提取期望的公司与 BOSS 姓名（用于发送前身份校验，防错发）
  const expect = JSON.parse(
    await evalIn(`(() => {
      const title = document.title || "";
      let company = title
        .replace(/^「.+?招聘」_/, "")
        .replace(/-BOSS直聘$/, "")
        .replace(/招聘$/, "");
      const body = document.body ? document.body.innerText : "";
      const m = body.match(/([\\u4e00-\\u9fa5]{2,3})(先生|女士|招聘者)/);
      const boss = m ? m[1] + (m[2] === "招聘者" ? "" : m[2]) : "";
      return JSON.stringify({ company, boss });
    })()`)
  );
  console.log("期望对象：" + (expect.company || "?") + (expect.boss ? " · " + expect.boss : ""));

  // 点击按钮（最多 3 次，间隔 >= 5 秒）
  let focused = "no-input";
  for (let attempt = 0; attempt < 3 && focused !== "ok"; attempt++) {
    const clicked = await evalIn(`(() => {
      const el = Array.from(document.querySelectorAll("a,button,span,div"))
        .find((e) => /立即沟通|继续沟通/.test(e.textContent || "") && e.children.length === 0);
      if (!el) return;
      el.click();
    })()`);
    console.log("点击次数 " + (attempt + 1) + "：" + (clicked === undefined ? "ok" : "no-btn"));
    // 被动等待输入框出现（最多 10 秒）
    for (let i = 0; i < 10 && focused !== "ok"; i++) {
      await sleep(1000);
      focused = await evalIn(`(() => {
        const el = document.querySelector("[contenteditable].chat-input");
        if (!el) return "no-input";
        el.focus();
        el.click();
        return "ok";
      })()`);
    }
    if (focused !== "ok" && attempt < 2) await sleep(5000); // 下次重试前间隔
  }
  console.log("输入框：" + focused);
  if (focused !== "ok") {
    const dbg = await evalIn(
      `(() => document.body ? document.body.innerText.slice(-500) : "")()`
    );
    console.log("页面尾部：" + dbg);
    throw new Error("未找到聊天输入框");
  }
  await sleep(250);

  // 风控兜底：输入前检测验证特征
  if (await checkRisk()) {
    console.log("⚠️ 检测到风控/验证特征，停止发送");
    ws.close();
    return { dup: false, risk: true };
  }

  // 记录对方身份（姓名+公司+职位），从聊天头部重试读取直到完整
  let bossInfo = "";
  for (let i = 0; i < 8 && bossInfo.length < 6; i++) {
    bossInfo = await evalIn(`(() => {
      const conv = document.querySelector(".chat-conversation");
      if (!conv) return "";
      const text = conv.innerText.replace(/\\s+/g, "");
      const idx = text.indexOf("更多");
      return idx > 0 ? text.slice(0, idx) : "";
    })()`);
    if (bossInfo.length < 6) await sleep(250);
  }
  console.log("对方：" + bossInfo);

  // 对方身份校验（强制）：聊天对象必须同时匹配期望公司；匹配到 BOSS 名时也必须一致，否则跳过（防错发）
  const got = bossInfo.replace(/\s+/g, "");
  const expectCompany = String(company || expect.company || "").replace(/招聘$/, "");
  let identityOk = true;
  let identityReason = "";
  if (expectCompany && !got.includes(expectCompany)) {
    identityOk = false;
    identityReason = "聊天对象(" + got.slice(0, 20) + ")与目标公司(" + expectCompany + ")不匹配";
  }
  if (identityOk && expect.boss && !got.includes(expect.boss)) {
    identityOk = false;
    identityReason = "聊天对象(" + got.slice(0, 20) + ")与目标BOSS(" + expect.boss + ")不匹配";
  }
  if (!identityOk) {
      console.log(
        "⚠️ " + identityReason + "，跳过（防错发）"
      );
      ws.close();
      return { dup: false, risk: false, bossMismatch: true };
  }

  await call("Input.insertText", { text: msg });
  await sleep(200);
  const typedLen = await evalIn(
    `(() => { const el = document.querySelector("[contenteditable].chat-input"); return el ? el.innerText.length : -1; })()`
  );
  console.log("已输入字符数：" + typedLen);
  if (!typedLen || typedLen < 10) throw new Error("消息未成功输入");

  // 确定性校验：输入框清空 且 消息片段出现在聊天记录
  const prefix = msg.replace(/\\s+/g, "").slice(0, 14);
  const checkSent = async () => {
    const s = await evalIn(`(() => {
      const el = document.querySelector("[contenteditable].chat-input");
      const empty = el ? el.innerText.trim().length === 0 : null;
      const body = document.body ? document.body.innerText : "";
      return JSON.stringify({ empty, found: body.includes(${JSON.stringify(prefix)}) });
    })()`);
    return JSON.parse(s);
  };

  let sent = false;
  for (let attempt = 0; attempt < 2 && !sent; attempt++) {
    // 点击发送按钮（主路径）
    const btnClicked = await evalIn(`(() => {
      const el = document.querySelector(".btn-send");
      if (!el || el.classList.contains("disabled")) return "disabled";
      el.click();
      return "clicked";
    })()`);
    console.log("发送按钮（第 " + (attempt + 1) + " 次）：" + btnClicked);
    if (btnClicked === "clicked") {
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        const st = await checkSent();
        if (st.empty === true && st.found === true) { sent = true; break; }
      }
    }
  }
  let riskFlag = false;
  if (!sent) riskFlag = await checkRisk();

  const fs = await import("node:fs");
  const now = new Date().toISOString().slice(0, 19);
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const line = [
    esc(now),
    esc(url),
    esc(msg),
    esc(bossInfo),
    sent ? "已送达" : riskFlag ? "风控拦截-待人工" : "待确认",
  ].join(",");
  fs.appendFileSync(LOG, line + "\n");
  console.log(
    sent
      ? "✅ 已送达（脚本校验通过）并记录"
      : riskFlag
        ? "⚠️ 风控拦截，已记录为风控拦截-待人工"
        : "⚠️ 未确认送达，已记录为待确认"
  );
  ws.close();
  return { dup: false, risk: riskFlag, sent };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await sendOpening({
    url: args.url,
    msg: args.msg,
    wait: parseInt(args.wait || "0", 10),
    company: args.company || "",
    force: args.force === true,
    checkOnly: args["check-only"] === true,
  });
  if (result.checkOnly) process.exit(result.contacted ? 4 : 0);
  if (result.risk) process.exit(1);
  if (result.dup) process.exit(0);
  if (result.urlMismatch || result.bossMismatch) process.exit(3);
  if (result.contacted) process.exit(4);
  process.exit(result.sent ? 0 : 2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      if (typeof args[key] !== "boolean") i++;
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}
