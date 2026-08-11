#!/usr/bin/env node
// 精筛前双保险：从当日 jobs-<日期>.json 剔除已发送过的 URL
// collect.mjs 合并时已自动剔除，本脚本防止其他来源手动写入/历史残留
// 用法：node scripts/filter-sent.mjs [--date 2026-08-11] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.mjs";

const normUrl = (u) => String(u || "").split("?")[0];

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

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const di = args.indexOf("--date");
  const date = di >= 0 && args[di + 1] ? args[di + 1] : null;
  const cfg = loadConfig();

  const sent = new Set();
  try {
    for (const l of readFileSync(`${cfg.dataDir}/发送记录.csv`, "utf8").split("\n").slice(1)) {
      if (!l.trim()) continue;
      const c = parseCsvLine(l);
      if (c[1]) sent.add(normUrl(c[1]));
    }
  } catch {
    console.log("未找到发送记录，无需过滤");
    return;
  }

  const today = date || new Date().toISOString().slice(0, 10);
  const p = `${cfg.dataDir}/jobs-${today}.json`;
  let jobs;
  try {
    jobs = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    console.log("未找到 " + p + "，无需过滤");
    return;
  }
  const kept = jobs.filter((j) => !sent.has(normUrl(j.href || j.url)));
  const dropped = jobs.length - kept.length;
  console.log(
    (dryRun ? "[dry-run] " : "") + p + "：" + jobs.length + " 条，剔除已发送 " + dropped + " 条，保留 " + kept.length + " 条"
  );
  if (!dryRun && dropped > 0) {
    writeFileSync(p, JSON.stringify(kept, null, 1));
    console.log("已写回");
  }
}

main();
