#!/usr/bin/env node
// 配置加载模块：读取项目根目录 profile.yaml，校验后导出配置对象
// 所有脚本统一从这里取配置，不再硬编码个人数据
// 依赖：npm install（yaml 包）
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = resolve(ROOT, "profile.yaml");
export const PROMPT_PATH = resolve(ROOT, "prompts", "screening.md");

const REQUIRED = [
  ["user_name", "user_name（你的称呼，仅用于记录）"],
  ["chrome.executable", "chrome.executable（Chrome 可执行文件路径）"],
  ["chrome.debug_port", "chrome.debug_port（调试端口）"],
  ["chrome.user_data_dir", "chrome.user_data_dir（独立资料目录）"],
  ["chrome.start_url", "chrome.start_url（启动后打开的页面）"],
  ["city", "city（城市名，用于硬过滤）"],
  ["city_code", "city_code（BOSS 直聘城市代码，如北京 101010100）"],
  ["search_keywords", "search_keywords（搜索关键词列表）"],
  ["salary_strict.min", "salary_strict.min（严格档最低薪资 K）"],
  ["salary_strict.max", "salary_strict.max（严格档最高薪资 K）"],
  ["salary_relaxed.min", "salary_relaxed.min（放宽档最低薪资 K）"],
  ["salary_relaxed.max", "salary_relaxed.max（放宽档最高薪资 K）"],
  ["exclude_keywords", "exclude_keywords（排除公司/行业关键词）"],
  ["exclude_companies", "exclude_companies（已知排除公司名单，可为空列表）"],
  ["jd_hard_exclude", "jd_hard_exclude（JD 硬伤正则列表）"],
  ["daily_target", "daily_target（每日目标数量）"],
  ["daily_max", "daily_max（每日上限）"],
  ["collect_pool_ratio", "collect_pool_ratio（采集池倍数，原始池 = daily_target × 倍数）"],
  ["mode", "mode（运行模式：auto=直接发送 / test=先审核）"],
  ["favorites_skip_screening", "favorites_skip_screening（收藏岗位是否跳过筛选直投）"],
  ["followup_interval_days", "followup_interval_days（跟进间隔天数）"],
  ["followup_max_days", "followup_max_days（最长跟进天数）"],
  ["followup_max_messages", "followup_max_messages（每人最多消息数）"],
  ["send_interval_seconds", "send_interval_seconds（发送随机间隔范围 [min,max]）"],
  ["data_dir", "data_dir（数据目录）"],
  ["profile.direction", "profile.direction（目标方向）"],
  ["profile.summary", "profile.summary（经历摘要）"],
  ["profile.company_standards", "profile.company_standards（公司入选标准）"],
  ["profile.opening_style", "profile.opening_style（开场白话术要求）"],
  ["profile.followup_style", "profile.followup_style（跟进话术要求）"],
];

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `未找到配置 ${CONFIG_PATH}\n请先复制 profile.example.yaml 为 profile.yaml，并填写你的求职信息。`
    );
  }
  let cfg;
  try {
    cfg = YAML.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(`profile.yaml 解析失败：${e.message}`);
  }
  validate(cfg);
  cfg._root = ROOT;
  cfg.dataDir = resolve(ROOT, cfg.data_dir || "./data");
  return cfg;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function validate(cfg) {
  const missing = REQUIRED.filter(
    ([path]) => getPath(cfg, path) === undefined || getPath(cfg, path) === ""
  );
  if (missing.length) {
    throw new Error(
      "profile.yaml 缺少必填字段：\n" +
        missing.map(([, label]) => "  - " + label).join("\n")
    );
  }
  if (!Array.isArray(cfg.search_keywords) || cfg.search_keywords.length === 0)
    throw new Error("profile.yaml 的 search_keywords 必须是非空列表");
  if (!Array.isArray(cfg.exclude_keywords))
    throw new Error("profile.yaml 的 exclude_keywords 必须是列表");
  if (!Array.isArray(cfg.exclude_companies))
    throw new Error("profile.yaml 的 exclude_companies 必须是列表");
  if (!(cfg.chrome.debug_port > 0))
    throw new Error("profile.yaml 的 chrome.debug_port 必须是大写端口数字");
  if (!(cfg.collect_pool_ratio > 0))
    throw new Error("profile.yaml 的 collect_pool_ratio 必须大于 0");
  if (!["auto", "test"].includes(cfg.mode))
    throw new Error("profile.yaml 的 mode 只能是 auto 或 test");
  if (typeof cfg.favorites_skip_screening !== "boolean")
    throw new Error("profile.yaml 的 favorites_skip_screening 必须是 true 或 false");
  if (!Array.isArray(cfg.jd_hard_exclude))
    throw new Error("profile.yaml 的 jd_hard_exclude 必须是列表");
  const [siMin, siMax] = cfg.send_interval_seconds || [];
  if (!(siMin > 0 && siMax >= siMin))
    throw new Error("profile.yaml 的 send_interval_seconds 必须是 [最小秒, 最大秒]");
  if (cfg.profile.resume_file && !existsSync(resolve(ROOT, cfg.profile.resume_file))) {
    throw new Error(
      `profile.yaml 指定的简历文件不存在：${cfg.profile.resume_file}\n` +
        "请把简历放到项目内（如 docs/resume.md）并填写相对路径，或删除该字段。"
    );
  }
  cfg.chrome.user_data_dir = expandHome(cfg.chrome.user_data_dir);
}

function expandHome(p) {
  if (typeof p !== "string") return p;
  return p === "~" || p.startsWith("~/") ? p.replace(/^~/, homedir()) : p;
}

// 把排除关键词列表转成正则（如 ["海尔","代运营"] -> /海尔|代运营/）
export function buildExcludeRegex(cfg) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(cfg.exclude_keywords.map(esc).join("|"));
}

// 把 JD 硬伤正则列表转成编译后的正则数组，{city} 会被替换为城市名
export function buildJdHardRegexes(cfg) {
  return cfg.jd_hard_exclude.map((p) => {
    const src = String(p).replace(/\{city\}/g, cfg.city);
    return new RegExp(src);
  });
}

// 读取简历文件全文（未配置时返回占位说明）
export function readResume(cfg) {
  if (!cfg.profile.resume_file) return "（未提供简历文件）";
  const p = resolve(ROOT, cfg.profile.resume_file);
  if (!existsSync(p)) return "（简历文件不存在）";
  return readFileSync(p, "utf8");
}

export function fmtSalary(strict, relaxed) {
  return `${strict.min}-${strict.max}K（特别匹配放宽 ${relaxed.min}-${relaxed.max}K）`;
}

// 用 profile 填充提示词模板，产出第二层 AI 可直接使用的完整指令
export function buildPrompt(cfg) {
  const template = readFileSync(PROMPT_PATH, "utf8");
  const vars = {
    "{{city}}": cfg.city,
    "{{target_jobs}}": cfg.target_jobs.join("、"),
    "{{salary}}": fmtSalary(cfg.salary_strict, cfg.salary_relaxed),
    "{{exclude_keywords}}": cfg.exclude_keywords.join("、"),
    "{{exclude_companies}}": cfg.exclude_companies.length
      ? cfg.exclude_companies.join("、")
      : "（未配置，按 AI 判断）",
    "{{daily_target}}": String(cfg.daily_target),
    "{{direction}}": cfg.profile.direction,
    "{{summary}}": String(cfg.profile.summary || "").trim(),
    "{{resume}}": readResume(cfg).trim(),
    "{{company_standards}}": String(cfg.profile.company_standards || "").trim(),
    "{{opening_style}}": String(cfg.profile.opening_style || "").trim(),
    "{{followup_style}}": String(cfg.profile.followup_style || "").trim(),
  };
  return template.replace(/{{[a-z_]+}}/g, (m) => vars[m] ?? `[缺少模板变量：${m}]`);
}

// 便捷工具：确保数据目录存在
export function ensureDataDir(cfg) {
  const fs = import("node:fs");
  return fs.then((f) => f.mkdirSync(cfg.dataDir, { recursive: true }));
}
