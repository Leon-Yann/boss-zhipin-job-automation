#!/usr/bin/env node
// 开场白质量校验（确定性脚本，不经过 AI）
// 输入：AI 输出的 JSON（含 jobs[].opening / openingStyle）或评审清单 CSV（开场白列）
// 用法：node validate-openings.mjs <文件> [--threshold 0.4]
// 检查：字数、禁用词、含数据、结尾同质、两两相似度、风格分布
import { readFileSync } from "node:fs";

const norm = (s) =>
  String(s || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：,.!?;:]/g, "");

const bigrams = (s) => {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};

// 字符级 bigram Jaccard 相似度（对同质模板很敏感）
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

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

function loadRows(file) {
  const raw = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    const obj = JSON.parse(raw);
    const jobs = obj.jobs || (Array.isArray(obj) ? obj : []);
    return jobs
      .filter((j) => j.match === "yes" && j.opening)
      .map((j) => ({
        name: j.company + "·" + j.jobTitle,
        opening: typeof j.opening === "string" ? j.opening : j.opening?.text || "",
        style: j.openingStyle || j.opening?.style || "",
      }));
  }
  // CSV：找"开场白"列
  const lines = raw.trim().split("\n");
  const header = parseCsvLine(lines[0]);
  let col = header.indexOf("开场白");
  if (col < 0) col = header.findIndex((h) => h.includes("开场白"));
  if (col < 0) throw new Error("CSV 中未找到'开场白'列");
  return lines.slice(1).map((l, i) => {
    const c = parseCsvLine(l);
    return {
      name: (c[2] || "?") + "·" + (c[3] || "?"),
      opening: c[col] || "",
      style: "",
    };
  });
}

function classifyEnding(text) {
  const t = String(text || "");
  if (/期待沟通|期待详聊|期待和您沟通|期待和您详聊/.test(t)) return "期待沟通";
  if (/期待面试|希望有机会面试|欢迎面试/.test(t)) return "期待面试";
  if (/期待详聊|期待进一步|期待交流|期待深入/.test(t)) return "期待详聊";
  if (/联系我|随时联系|欢迎联系/.test(t)) return "邀请联系";
  if (/一起探讨|一起聊聊|可以聊聊|想和您聊聊/.test(t)) return "探讨邀约";
  if (/欢迎交流|随时交流|期待交流/.test(t)) return "交流";
  return "其他";
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const ti = args.indexOf("--threshold");
  const threshold = ti >= 0 ? parseFloat(args[ti + 1]) : 0.4;
  if (!file) {
    console.error("用法：node validate-openings.mjs <JSON或CSV> [--threshold 0.4]");
    process.exit(2);
  }
  const rows = loadRows(file).filter((r) => r.opening);
  if (!rows.length) {
    console.log("没有可校验的开场白（0 条）");
    process.exit(1);
  }

  const issues = [];
  const endings = {};
  const styles = {};
  const normed = rows.map((r) => ({ ...r, t: norm(r.opening) }));

  for (let i = 0; i < normed.length; i++) {
    const r = normed[i];
    const t = r.t;
    const reasons = [];
    const len = r.opening.length;
    if (len < 80 || len > 260) reasons.push("长度异常(" + len + "字)");
    if (!/\d/.test(t)) reasons.push("无具体数字(缺数据支撑)");
    if (/您好|你好|您好呀/.test(t)) reasons.push("含寒暄词(您好/你好)");
    if (/想聊聊.*挑战/.test(t)) reasons.push("结尾'想聊聊…挑战'");

    // 两两相似度：只与前面的比
    let maxSim = 0;
    let maxIdx = -1;
    for (let j = 0; j < i; j++) {
      const s = similarity(t, normed[j].t);
      if (s > maxSim) {
        maxSim = s;
        maxIdx = j;
      }
    }
    if (maxSim >= threshold)
      reasons.push(
        "与第" + (maxIdx + 1) + "条同质(相似度" + maxSim.toFixed(2) + ")"
      );

    const end = classifyEnding(r.opening);
    endings[end] = (endings[end] || 0) + 1;
    if (r.style) styles[r.style] = (styles[r.style] || 0) + 1;

    if (reasons.length) {
      issues.push({ name: r.name, reasons });
      console.log("❌ [重写] " + r.name + "：" + reasons.join("；"));
    } else {
      console.log("✅ [" + (end === "其他" ? "结尾待查" : end) + "] " + r.name);
    }
  }

  // 全局警告
  const warns = [];
  const topEnd = Object.entries(endings).sort((a, b) => b[1] - a[1])[0];
  if (topEnd && topEnd[0] !== "其他" && topEnd[1] / rows.length > 0.4)
    warns.push("结尾同质：'" + topEnd[0] + "' 占 " + topEnd[1] + "/" + rows.length);
  const st = Object.entries(styles).sort((a, b) => b[1] - a[1])[0];
  if (st && st[1] / rows.length > 0.6)
    warns.push("风格集中：'" + st[0] + "' 占 " + st[1] + "/" + rows.length);

  console.log("\n===== 汇总 =====");
  console.log("总条数：" + rows.length + "，待重写：" + issues.length);
  console.log("结尾分布：" + JSON.stringify(endings));
  if (Object.keys(styles).length)
    console.log("风格分布：" + JSON.stringify(styles));
  for (const w of warns) console.log("⚠️ " + w);

  process.exit(issues.length ? 1 : 0);
}

main();
