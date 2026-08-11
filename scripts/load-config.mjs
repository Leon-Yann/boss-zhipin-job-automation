#!/usr/bin/env node
// 配置校验与查看工具（不需要浏览器，可随时运行）
// 用法：
//   node load-config.mjs               # 校验并打印摘要（默认）
//   node load-config.mjs --check       # 同上
//   node load-config.mjs --filters     # 打印硬过滤规则 JSON（供脚本调试）
//   node load-config.mjs --prompt      # 打印生成后的完整 AI 提示词
//   node load-config.mjs --save-prompt <路径>   # 保存提示词到文件
import { writeFileSync } from "node:fs";
import {
  loadConfig,
  buildExcludeRegex,
  buildJdHardRegexes,
  buildPrompt,
  fmtSalary,
} from "./config.mjs";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (args.filters) {
    console.log(
      JSON.stringify(
        {
          city: cfg.city,
          city_code: cfg.city_code,
          search_keywords: cfg.search_keywords,
          exclude_regex: buildExcludeRegex(cfg).source,
          exclude_companies: cfg.exclude_companies,
          jd_hard_regexes: buildJdHardRegexes(cfg).map((r) => r.source),
          salary_strict: cfg.salary_strict,
          salary_relaxed: cfg.salary_relaxed,
          daily: { target: cfg.daily_target, max: cfg.daily_max },
          followup: {
            interval_days: cfg.followup_interval_days,
            max_days: cfg.followup_max_days,
            max_messages: cfg.followup_max_messages,
          },
          send_interval_seconds: cfg.send_interval_seconds,
          data_dir: cfg.dataDir,
        },
        null,
        2
      )
    );
    return;
  }

  if (args.prompt || args["save-prompt"]) {
    const prompt = buildPrompt(cfg);
    if (args["save-prompt"]) {
      writeFileSync(args["save-prompt"], prompt);
      console.log("AI 提示词已保存：" + args["save-prompt"]);
    } else {
      console.log(prompt);
    }
    return;
  }

  // 默认：--check 摘要
  console.log("✅ profile.yaml 校验通过");
  console.log("  用户：" + cfg.user_name);
  console.log("  城市：" + cfg.city + "（代码 " + cfg.city_code + "）");
  console.log("  方向：" + cfg.profile.direction);
  console.log("  关键词：" + cfg.search_keywords.join("、"));
  console.log("  薪资：" + fmtSalary(cfg.salary_strict, cfg.salary_relaxed));
  console.log("  排除关键词：" + cfg.exclude_keywords.join("、"));
  console.log(
    "  排除公司名单：" +
      (cfg.exclude_companies.length
        ? cfg.exclude_companies.join("、")
        : "（未配置，交由 AI 判断）")
  );
  console.log("  每日目标：" + cfg.daily_target + "（上限 " + cfg.daily_max + "）");
  console.log(
    "  采集池：" + cfg.daily_target + " × " + cfg.collect_pool_ratio + " = " +
      cfg.daily_target * cfg.collect_pool_ratio + "（原始池目标）"
  );
  console.log(
    "  运行模式：" +
      (cfg.mode === "auto" ? "auto（生成后直接发送）" : "test（先审核后发送）")
  );
  console.log(
    "  收藏岗位：" +
      (cfg.favorites_skip_screening
        ? "跳过筛选，直接生成开场白沟通"
        : "与普通岗位一样先筛选")
  );
  console.log(
    "  跟进：" + cfg.followup_interval_days + " 天一次，最长 " +
      cfg.followup_max_days + " 天，每人最多 " + cfg.followup_max_messages + " 条"
  );
  console.log("  简历文件：" + (cfg.profile.resume_file || "（未配置）"));
  console.log("  数据目录：" + cfg.dataDir);
  console.log("\n常用命令：");
  console.log("  node scripts/load-config.mjs --filters   # 查看硬过滤规则");
  console.log("  node scripts/load-config.mjs --prompt    # 查看 AI 提示词全文");
}

main();
