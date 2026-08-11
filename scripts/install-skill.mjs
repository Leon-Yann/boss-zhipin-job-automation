#!/usr/bin/env node
// 安装 Skill 到 Codex 技能库：复制 skill/boss-zhipin-job → ~/.codex/skills/boss-zhipin-job
// 并把 SKILL.md 中的 <项目目录> 占位符替换为当前项目实际路径
// 用法：node scripts/install-skill.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "skill", "boss-zhipin-job");
const DEST = resolve(homedir(), ".codex", "skills", "boss-zhipin-job");

if (!existsSync(SRC)) {
  throw new Error("未找到技能目录：" + SRC);
}

mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const mdPath = resolve(DEST, "SKILL.md");
const content = readFileSync(mdPath, "utf8").replaceAll("<项目目录>", ROOT);
writeFileSync(mdPath, content);

console.log("✅ Skill 已安装：" + DEST);
console.log("   项目路径已写入：" + ROOT);
console.log("   更新项目后重新运行本命令即可同步技能。");
