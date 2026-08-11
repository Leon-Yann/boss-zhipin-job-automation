#!/usr/bin/env node
// 重建评审清单 CSV：岗位职责列 = 脚本从详情页提取的 JD 原文（不经过 AI）
// 开场白/状态从旧评审清单继承；输出含岗位链接列
// 注意：JOBS 列表是开发期手工维护的岗位清单，正式流程由 collect.mjs 输出 raw-*.json 驱动
import { readdirSync } from "node:fs";
import { loadConfig } from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;

const JOBS = [
  { url: "https://www.zhipin.com/job_detail/7202a8548cd3c5170nFz09S_GVJX.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/f62f3a5db71cbb430nF62du1FFJU.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/b6df64d5d2100ed01nZ40ty4FFdU.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/5c62d4a82667f4bc0nJ509i8FVRT.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/321c9f3d984f42190nV52tW8EFpU.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/3af695f48368772e0nF93N6-EltU.html", source: "搜索/推荐" },
  { url: "https://www.zhipin.com/job_detail/dfece865afd584b40nF909m8F1ZY.html", source: "搜索" },
  { url: "https://www.zhipin.com/job_detail/2abd7ec721d2a6cb0nd90tm8FlZS.html", source: "推荐流" },
  { url: "https://www.zhipin.com/job_detail/f4d98fe0c56cf9dc0ndz39m9EFpR.html", source: "推荐流" },
  { url: "https://www.zhipin.com/job_detail/3e4ebc6111f1ecc20nVy2NS9ElpW.html", source: "推荐流" },
  { url: "https://www.zhipin.com/job_detail/7f0793ebab9fe5580nFz0tu-EVVV.html", source: "推荐流" },
  { url: "https://www.zhipin.com/job_detail/99be7ba49060e5e203d43N69EFtS.html", source: "收藏" },
  { url: "https://www.zhipin.com/job_detail/6b18bb7fa83992780nF72921GFtQ.html", source: "收藏" },
  { url: "https://www.zhipin.com/job_detail/cf42504ce966ee5f1Hxy2tW-GVBQ.html", source: "收藏" },
  { url: "https://www.zhipin.com/job_detail/6b0113d0946c7f120nJ539i9EFtS.html", source: "收藏" },
];

const EXTRACT = `(() => {
  const body = document.body ? document.body.innerText : "";
  const sel = document.querySelector(
    ".job-sec-text, [class*='job-detail'] .job-sec-text, [class*='job-sec']"
  );
  let jd = sel ? sel.innerText : "";
  if (!jd) jd = body;
  const salaryMatch = body.match(
    /(\\d{1,3}\\s*[-~—]\\s*\\d{1,3}K(?:\\s*·\\s*\\d{1,2}薪)?)/
  );
  const onlineEl = document.querySelector(".boss-online-tag");
  const titleMatch = document.title.match(/「(.+?)招聘」/);
  const company = document.title
    .replace(/^「.+?招聘」_/, "")
    .replace(/-BOSS直聘$/, "")
    .replace(/招聘$/, "");
  return JSON.stringify({
    jobTitle: titleMatch ? titleMatch[1] : null,
    company,
    salary: salaryMatch ? salaryMatch[1].replace(/\\s+/g, "") : null,
    bossOnline: onlineEl ? onlineEl.innerText.trim().slice(0, 30) : null,
    jd: jd.replace(/\\s+/g, " ").trim().slice(0, 4000),
  });
})()`;

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
const toField = (s) => '"' + String(s || "").replace(/"/g, '""') + '"';
const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/招聘$/g, "");

async function main() {
  const fs = await import("node:fs");
  const cfg = loadConfig();
  const BASE = cfg.dataDir;
  // 取 data 目录里最新的一份评审清单 CSV 作为"旧清单"（继承开场白/状态）
  const oldFiles = readdirSync(BASE)
    .filter((f) => /评审清单\.csv$/.test(f))
    .sort()
    .reverse();
  if (!oldFiles.length) throw new Error(`未在 ${BASE} 找到旧评审清单 CSV`);
  const OLD_CSV = `${BASE}/${oldFiles[0]}`;
  const dateMatch = oldFiles[0].match(/^(\d{4}-\d{2}-\d{2})/);
  const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  const oldRows = fs
    .readFileSync(OLD_CSV, "utf8")
    .trim()
    .split("\n")
    .map(parseCsvLine)
    .map((c) => ({
      company: c[2],
      title: c[3],
      opening: c[6],
      status: c[7],
    }));

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
      }, 40000);
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
      throw new Error("页面出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const out = [];
  for (const j of JOBS) {
    await call("Page.navigate", { url: j.url });
    await new Promise((r) => setTimeout(r, 4500));
    const d = JSON.parse((await evalIn(EXTRACT)) || "{}");
    const old = oldRows.find(
      (o) => norm(o.company) === norm(d.company) && norm(o.title) === norm(d.jobTitle)
    );
    out.push({
      日期: dateStr,
      来源: j.source,
      公司: d.company || j.company,
      岗位名称: d.jobTitle || "",
      薪资: d.salary || "",
      "职位详情(原文)": d.jd,
      开场白: old ? old.opening : "",
      状态: old ? old.status : "",
      BOSS在线: d.bossOnline || "",
      链接: j.url,
    });
    console.log("[" + out.length + "] " + (d.company || "") + " · " + (d.jobTitle || "") + " · JD " + (d.jd ? d.jd.length : 0) + " 字");
  }

  const header = ["日期", "来源", "公司", "岗位名称", "薪资", "职位详情(原文)", "开场白", "状态", "BOSS在线", "链接"];
  const lines = [header.map(toField).join(",")];
  for (const r of out) lines.push(header.map((h) => toField(r[h])).join(","));
  fs.writeFileSync(OLD_CSV, lines.join("\n") + "\n");
  fs.writeFileSync(`${BASE}/raw-review.json`, JSON.stringify(out, null, 1));
  console.log("评审清单已重建（岗位职责为脚本抓取的原文）：" + OLD_CSV);
  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
