#!/usr/bin/env node
// 启动调试版 Chrome（带 CDP 调试端口 + 独立资料目录），并打开 BOSS 直聘
// 由 AI 或用户执行同一脚本：node scripts/launch-chrome.mjs
// 用法：
//   node scripts/launch-chrome.mjs               # 启动并打开配置的 start_url
//   node scripts/launch-chrome.mjs --open <URL>  # 启动并打开指定 URL
//   node scripts/launch-chrome.mjs --check       # 只检查调试端口是否已就绪
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portReady(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

async function openTab(port, url) {
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" }
    );
    return r.ok;
  } catch {
    return false;
  }
}

// 该资料目录的 Chrome 是否已在运行（但没有调试端口）
function profileRunning(userDataDir) {
  try {
    execFileSync("pgrep", ["-f", userDataDir], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyCheck = argv.includes("--check");
  const openIdx = argv.indexOf("--open");
  const openUrl = openIdx >= 0 && argv[openIdx + 1] ? argv[openIdx + 1] : null;

  const cfg = loadConfig();
  const ch = cfg.chrome;
  const port = ch.debug_port;
  const userDataDir = ch.user_data_dir;
  const targetUrl = openUrl || ch.start_url;

  if (await portReady(port)) {
    console.log(`✅ 调试端口 ${port} 已就绪，Chrome 已在运行`);
    if (!onlyCheck) {
      const ok = await openTab(port, targetUrl);
      console.log(ok ? "已打开页面：" + targetUrl : "打开页面失败（可手动打开）");
    }
    return;
  }

  if (onlyCheck) {
    console.log(`❌ 调试端口 ${port} 未就绪`);
    process.exit(1);
  }

  if (!existsSync(ch.executable)) {
    throw new Error(
      `未找到 Chrome：${ch.executable}\n请检查 profile.yaml 的 chrome.executable 配置`
    );
  }
  if (profileRunning(userDataDir)) {
    throw new Error(
      `检测到资料目录（${userDataDir}）的 Chrome 已在运行，但它没有开启调试端口。\n` +
        "请先完全退出这个 Chrome 窗口（Cmd+Q），再重新运行本命令。"
    );
  }

  console.log("启动调试版 Chrome...");
  const child = spawn(
    ch.executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      targetUrl,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref(); // 脚本退出后 Chrome 保持运行

  // 轮询等待调试端口就绪（最长 30 秒）
  for (let i = 0; i < 30; i++) {
    if (await portReady(port)) {
      console.log(`✅ 调试版 Chrome 已启动（端口 ${port}）`);
      console.log(`  页面：${targetUrl}`);
      console.log(`  登录态目录：${userDataDir}（关闭窗口、重启电脑都不会丢）`);
      return;
    }
    await sleep(1000);
  }
  throw new Error("Chrome 启动超时，请检查 profile.yaml 的 chrome.executable 配置");
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
