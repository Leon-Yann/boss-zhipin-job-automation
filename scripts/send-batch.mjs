#!/usr/bin/env node
// 通用批量发送：从评审文件（review JSON 或评审清单 CSV）逐条发送
// url 与 opening 取自同一条记录，杜绝手工配对；
// send.mjs 内部会跳过已沟通岗位（exit 4）、做身份校验（exit 3）、检测风控（exit 1）
// 用法：
//   node scripts/send-batch.mjs --review <文件> [--limit N] [--resume-log <路径>] [--force] [--dry-run]
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

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

function loadTargets(file) {
  if (file.endsWith(".json")) {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    const jobs = obj.jobs || (Array.isArray(obj) ? obj : []);
    return jobs
      .filter((j) => j.match === "yes" && j.opening)
      .map((j) => ({
        url: j.url,
        company: j.company || "",
        jobTitle: j.jobTitle || "",
        opening: typeof j.opening === "string" ? j.opening : j.opening?.text || "",
      }));
  }
  // CSV：按表头找"链接"和"开场白"列
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const colUrl = header.findIndex((h) => h.includes("链接"));
  const colOpening = header.findIndex((h) => h.includes("开场白"));
  const colCompany = header.findIndex((h) => h.includes("公司"));
  if (colUrl < 0 || colOpening < 0)
    throw new Error("CSV 中未找到'链接'或'开场白'列");
  return lines.slice(1).map((l) => {
    const c = parseCsvLine(l);
    return {
      url: c[colUrl] || "",
      company: colCompany >= 0 ? c[colCompany] || "" : "",
      jobTitle: c[3] || "",
      opening: c[colOpening] || "",
    };
  }).filter((t) => t.url && t.opening);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const reviewFile = args.review;
  if (!reviewFile) throw new Error("用法：node send-batch.mjs --review <评审文件>");

  const targets = loadTargets(reviewFile);
  console.log("待发送岗位：" + targets.length + " 条（来源 " + reviewFile + "）");
  const limit = parseInt(args.limit || String(targets.length), 10);
  const slice = targets.slice(0, limit);

  const resumeLog = args["resume-log"] || null;
  const tried = new Set();
  if (resumeLog && existsSync(resumeLog)) {
    for (const l of readFileSync(resumeLog, "utf8").trim().split("\n"))
      if (l) tried.add(l);
  }
  if (args["dry-run"]) {
    console.log("[dry-run] 将发送 " + slice.length + " 条（跳过已尝试 " + tried.size + " 条）");
    for (const t of slice.slice(0, 5))
      console.log("  - " + (t.company || "?") + " · " + (t.jobTitle || "?"));
    return;
  }

  const [minWait, maxWait] = cfg.send_interval_seconds || [30, 90];
  const stats = { sent: 0, skipped: 0, contacted: 0, mismatch: 0, failed: 0 };

  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    if (tried.has(t.url)) {
      stats.skipped++;
      continue;
    }
    if (i > 0) {
      const w = rand(minWait, maxWait);
      console.log(`\n[${i + 1}/${slice.length}] 等待 ${w} 秒（拟人节奏）...`);
      await sleep(w * 1000);
    }
    console.log(`[${i + 1}/${slice.length}] 发送：${t.company || "?"} · ${t.jobTitle || "?"}`);
    const argv = [
      "scripts/send.mjs",
      "--url", t.url,
      "--msg", t.opening,
    ];
    if (t.company) argv.push("--company", t.company);
    if (args.force) argv.push("--force");
    const r = spawnSync("node", argv, { stdio: "inherit", timeout: 180000 });
    const code = r.status;
    if (code === 0) stats.sent++;
    else if (code === 3) {
      stats.mismatch++;
      console.log("  ⏭ 身份/URL 校验未通过，跳过（不计入发送）");
    } else if (code === 4) {
      stats.contacted++;
      console.log("  ⏭ 已沟通过，跳过（防重复打扰）");
    } else if (code === 1) {
      console.log("⚠️ 检测到风控，停止批量发送");
      break;
    } else {
      stats.failed++;
      console.log("⚠️ 发送失败（exit " + code + "），继续下一条");
    }
    if (resumeLog) appendFileSync(resumeLog, t.url + "\n");
    await sleep(1500);
  }
  console.log("\n===== 批量完成 =====");
  console.log(
    "成功 " + stats.sent +
    " | 已沟通跳过 " + stats.contacted +
    " | 身份不符跳过 " + stats.mismatch +
    " | 失败 " + stats.failed +
    " | 断点跳过 " + stats.skipped
  );
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
