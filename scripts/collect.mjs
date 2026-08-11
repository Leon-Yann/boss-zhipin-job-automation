#!/usr/bin/env node
// 批量采集：从指定来源抓岗位 → 抓详情（JD/真实薪资/BOSS在线/公司信息）→ 硬过滤
// 每轮结果自动合并进：data/jobs-<日期>.json（当日全来源累计，AI 精筛输入）和
//                   data/raw-<来源>.json（同来源累计，历史追溯），均按岗位 URL 去重，不覆盖
// 用法：
//   node collect.mjs --source search --query 电商运营
//   node collect.mjs --source search --queries 电商运营,京东运营 --pages 2
//   node collect.mjs --source recommend
//   node collect.mjs --source favorites
//   --limit N        尝试上限（默认 = daily_target × collect_pool_ratio）
//   --max-results N  结果上限（默认 = daily_target × collect_pool_ratio）
//   --no-merge       只打印 JSON，不写任何文件
// 所有个人过滤条件来自项目根目录 profile.yaml（见 config.mjs）
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  loadConfig,
  buildExcludeRegex,
  buildJdHardRegexes,
} from "./config.mjs";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCES = {
  search: (q, p, cityCode) =>
    `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(
      q
    )}&city=${cityCode}${p > 1 ? `&page=${p}` : ""}`,
  recommend: () => "https://www.zhipin.com/web/geek/jobs",
  favorites: (q, p) =>
    `https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=${p || 1}&tag=4`,
};

const EXTRACT_CARDS = `(() => {
  const anchors = Array.from(document.querySelectorAll("a[href*='/job_detail/']"));
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const href = a.href.split("?")[0];
    if (seen.has(href) || !href.includes(".html")) continue;
    seen.add(href);
    const card =
      a.closest("li") ||
      a.closest("[class*='job-card']") ||
      a.closest("[class*='job-list'] > *") ||
      a.closest("div");
    const text = (card ? card.innerText : a.innerText)
      .replace(/\\s+/g, " ")
      .trim();
    const salaryCount = (text.match(/\\d{1,3}\\s*[-~—]\\s*\\d{1,3}\\s*K/g) || [])
      .length;
    const btnEl = card ? card.querySelector(".btn-startchat") : null;
    const btn = btnEl ? btnEl.textContent.trim() : "";
    out.push({ href, text: text.slice(0, 500), salaryCount, btn });
  }
  return JSON.stringify({ url: location.href, items: out });
})()`;

const EXTRACT_DETAIL = `(() => {
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
  const btnEl = Array.from(document.querySelectorAll("a,button,span,div"))
    .find((e) => /立即沟通|继续沟通/.test(e.textContent || "") && e.children.length === 0);
  const ciIdx = body.indexOf("公司基本信息");
  const companyInfo =
    ciIdx >= 0
      ? body.slice(ciIdx + 6, ciIdx + 400).replace(/\\s+/g, " ").trim()
      : null;
  const titleMatch = document.title.match(/「(.+?)招聘」/);
  const companyFromTitle = document.title
    .replace(/^「.+?招聘」_/, "")
    .replace(/-BOSS直聘$/, "");
  return JSON.stringify({
    url: location.href,
    jobTitle: titleMatch ? titleMatch[1] : null,
    company: companyFromTitle || null,
    salary: salaryMatch ? salaryMatch[1].replace(/\\s+/g, "") : null,
    bossOnline: onlineEl ? onlineEl.innerText.trim().slice(0, 30) : null,
    contactBtn: btnEl ? btnEl.textContent.trim().slice(0, 6) : "",
    companyInfo,
    jd: jd.replace(/\\s+/g, " ").slice(0, 2000),
  });
})()`;

function parseSalary(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,3})\s*[-~—]\s*(\d{1,3})K/);
  if (!m) return null;
  return { low: parseInt(m[1], 10), high: parseInt(m[2], 10), raw: s };
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function normUrl(u) {
  return String(u || "").split("?")[0];
}

// 读取发送记录.csv 中的岗位 URL 集合（已发送过的不再进入 AI 输入）
function readSentUrls(cfg) {
  const p = `${cfg.dataDir}/发送记录.csv`;
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const line of text.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols[1]) out.add(normUrl(cols[1]));
  }
  return out;
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

// 按岗位 URL 去重合并：保留先采集到的版本，同一轮内的重复也去掉
function mergeByUrl(prev, next) {
  const seen = new Set();
  const out = [];
  for (const it of [...prev, ...next]) {
    const k = normUrl(it.href || it.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function salaryOk(sal, cfg) {
  if (!sal) return true; // 无法解析视为通过，交给后续
  // 放宽档下限 + 严格档下限：命中放宽区间且岗位能达到严格档薪资
  return (
    sal.low >= cfg.salary_relaxed.min &&
    sal.high >= cfg.salary_strict.min
  );
}

async function main() {
  const cfg = loadConfig();
  const EXCLUDE = buildExcludeRegex(cfg);
  const jdHard = buildJdHardRegexes(cfg);
  const args = parseArgs(process.argv.slice(2));
  const source = args.source || "search";
  const poolRatio = cfg.collect_pool_ratio || 3;
  const poolTarget = cfg.daily_target * poolRatio;
  const limit = parseInt(args.limit || String(poolTarget), 10);
  const maxResults = parseInt(args["max-results"] || String(poolTarget), 10);
  const maxPages = parseInt(args.pages || "1", 10);
  console.log(
    "本次采集池目标 " + maxResults + " 条（= daily_target × " + poolRatio +
      "；尝试上限 " + limit + "）"
  );
  if (!SOURCES[source]) throw new Error("未知来源：" + source);
  const queries = args.queries
    ? String(args.queries).split(",").map((s) => s.trim()).filter(Boolean)
    : args.query
      ? [String(args.query)]
      : cfg.search_keywords;

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
      throw new Error("页面出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const navigate = async (u) => {
    await call("Page.navigate", { url: u });
    await sleep(4000);
  };

  const cards = [];
  const seenCards = new Set();
  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      if (source === "recommend") {
        if (page === 1) {
          console.log("来源 " + source + " | " + SOURCES.recommend());
          await navigate(SOURCES.recommend());
        } else {
          // 推荐流：滚动到底部触发加载更多
          console.log("来源 " + source + " | 滚动加载第 " + page + " 批");
          await evalIn(
            `(() => { window.scrollTo(0, document.body.scrollHeight); })()`
          );
        }
        await sleep(2500);
      } else {
        const url = SOURCES[source](q, page, cfg.city_code);
        console.log(
          "来源 " + source + " | 关键词：" + q + " | 第 " + page + " 页 | " + url
        );
        await navigate(url);
        await sleep(2000);
      }
      const cardsRaw = await evalIn(EXTRACT_CARDS);
      const items = JSON.parse(cardsRaw).items;
      let kept = 0;
      for (const c of items) {
        // 已沟通过的 boss/岗位（按钮为"继续沟通"）排除；按岗位 URL 去重
        if (c.btn === "继续沟通") continue;
        if (seenCards.has(c.href)) continue;
        seenCards.add(c.href);
        cards.push(c);
        kept++;
      }
      console.log("该批候选 " + items.length + "，排除已沟通/重复后保留 " + kept);
      if (kept === 0 && page > 1) break; // 本批无新增，停止翻页
    }
  }
  console.log("多关键词合并去重后候选 " + cards.length + " 个");

  const results = [];
  let tried = 0;
  const directFavorites =
    source === "favorites" && cfg.favorites_skip_screening === true;
  if (directFavorites) {
    console.log("来源 favorites：跳过筛选（用户已确认投递），直接进入开场白生成");
  }
  for (const card of cards) {
    if (results.length >= maxResults || tried >= limit) break;
    const text = card.text;
    if (source === "favorites" && card.salaryCount !== 1) continue; // 收藏页过滤混合卡片
    let cardSalary = null;
    if (!directFavorites) {
      if (!text.includes(cfg.city)) continue;
      if (EXCLUDE.test(text)) continue;
      cardSalary = parseSalary(text);
      if (cardSalary && !salaryOk(cardSalary, cfg)) continue;
    }
    tried++;
    await navigate(card.href);
    await sleep(2500);
    const detailRaw = await evalIn(EXTRACT_DETAIL);
    const d = JSON.parse(detailRaw);
    if (d.contactBtn.includes("继续沟通")) {
      console.log("  ⏭ 已沟通-排除（按钮为继续沟通）：" + (d.jobTitle || "?"));
      continue;
    }
    const realSalary = parseSalary(d.salary);
    if (!directFavorites) {
      if (realSalary && !salaryOk(realSalary, cfg)) continue;
      if (d.companyInfo && EXCLUDE.test(d.companyInfo)) continue;
      if (jdHard.some((re) => re.test(d.jd))) {
        console.log("  ⏭ JD 硬伤（" + d.jobTitle + "）");
        continue;
      }
      const excludedCompany = (cfg.exclude_companies || []).some((c) =>
        (d.company || "").includes(c) || text.includes(c)
      );
      if (excludedCompany) {
        console.log("  ⏭ 排除公司名单命中（" + (d.company || "?") + "）");
        continue;
      }
    }
    const relaxed =
      !directFavorites && realSalary
        ? realSalary.low < cfg.salary_strict.min
        : false;
    results.push({
      source,
      href: d.url,
      jobTitle: d.jobTitle || text.split(" ")[0],
      company: d.company || null,
      salary: d.salary || (cardSalary ? cardSalary.raw : null),
      relaxed,
      bossOnline: d.bossOnline,
      companyInfo: d.companyInfo,
      jd: d.jd,
      cardText: text,
    });
    console.log(
      "[" + results.length + "] " + (d.company || "?") + " · " +
        (d.jobTitle || "?") + " · " + (d.salary || "薪资未知")
    );
  }
  console.log("=====JSON=====");
  console.log(JSON.stringify(results, null, 1));
  mkdirSync(cfg.dataDir, { recursive: true });
  if (args["no-merge"]) {
    console.log("--no-merge：未写文件");
    ws.close();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  // 1) 同来源累计文件：合并去重，不覆盖（重复采集同来源不会丢上一轮）
  const srcPath = `${cfg.dataDir}/raw-${source}.json`;
  const mergedSrc = mergeByUrl(readJson(srcPath), results);
  writeFileSync(srcPath, JSON.stringify(mergedSrc, null, 1));
  console.log("来源累计已合并：" + srcPath + "（共 " + mergedSrc.length + " 条）");
  // 2) 当日全来源累计文件：AI 精筛的正式输入；剔除已发送过的 URL（防跨轮次残留）
  const dailyPath = `${cfg.dataDir}/jobs-${today}.json`;
  const sentUrls = readSentUrls(cfg);
  const kept = results.filter((r) => !sentUrls.has(normUrl(r.href)));
  const prevDaily = readJson(dailyPath).filter((r) => !sentUrls.has(normUrl(r.href)));
  const mergedDaily = mergeByUrl(prevDaily, kept);
  writeFileSync(dailyPath, JSON.stringify(mergedDaily, null, 1));
  const dropped = results.length - kept.length;
  console.log(
    "当日累计已合并：" + dailyPath + "（共 " + mergedDaily.length + " 条，剔除已发送 " + dropped + " 条）"
  );
  ws.close();
  setTimeout(() => process.exit(0), 300);
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

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
