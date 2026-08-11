---
name: boss-zhipin-job
description: 在 BOSS 直聘上执行求职自动化：采集岗位、AI 精筛并生成个性化开场白、真实浏览器发送消息、跟进未读 HR。当用户说"开始今天的 BOSS 直聘任务"、"开始今天的"、"采集岗位"、"看岗位"、"发送开场白"、"跟进未读"或要求执行本流程任何步骤时使用。通过 CDP 控制用户本机调试版 Chrome，调用项目脚本（<项目目录>）。
---

# BOSS直聘求职自动化

## 概述

三段式求职流程：脚本从 BOSS 直聘批量采集岗位并按配置硬过滤（零 token）→ AI 精筛并生成开场白 → 脚本真实浏览器发送与跟进（零 token）。项目根目录：`<项目目录>`（由 `scripts/install-skill.mjs` 安装时替换为实际路径），个人配置在 `profile.yaml`，脚本在 `scripts/`，数据在 `data/`。

## 开始前检查（每次执行先做）

1. 校验配置：`cd <项目目录> && node scripts/load-config.mjs --check`，失败则请用户修复 profile.yaml；
2. 检查调试 Chrome：`node scripts/launch-chrome.mjs --check`（localhost:9222）。沙箱内连不上 localhost，必须提权运行；
3. 端口未就绪时运行 `node scripts/launch-chrome.mjs` 启动（GUI 操作需用户授权；已运行则自动复用并打开 BOSS 直聘）；
4. 所有浏览器操作（CDP 连接、GUI 启动）都需要提权；首次授权后通常可记住。

## 任务一：当日新沟通

1. 采集：**`daily_target`（默认 100，以 profile.yaml 为准）指当天筛出并发送 100 条开场白，不是采集 100 个岗位再挑**。原始池目标 = `daily_target × collect_pool_ratio`（默认 300），`--limit` / `--max-results` 不传即自动按此执行。单个来源不足时，用多关键词（`--queries "a,b"`）、多来源（search / recommend / favorites）和翻页（`--pages N`）迭代，直到原始池够大或没有新岗位。示例：`node scripts/collect.mjs --source search --queries 电商运营,京东运营 --pages 2`。**每轮采集会自动合并进 `data/jobs-<日期>.json` 并按岗位 URL 去重（同来源重复采集不会覆盖丢失），进度以该文件去重后的条数为准**；**已沟通过（详情页按钮为"继续沟通"）的岗位在采集时自动排除；合并当日累计时自动剔除发送记录里已有的 URL**；**收藏来源（favorites）在 profile.yaml `favorites_skip_screening: true` 时跳过筛选但仍排除已沟通岗位**；
2. 精筛前双保险（可选）：`node scripts/filter-sent.mjs --dry-run` 查看将剔除的已发送岗位；确认无误后不带 `--dry-run` 执行；
3. 生成 AI 指令：`node scripts/load-config.mjs --prompt`，得到含画像/简历/规则的完整提示词；
4. AI 精筛与生成（对话内完成，无脚本）：读取 `data/jobs-<日期>.json`（当日累计，脚本已自动去重合并、剔除已沟通/已发送），按提示词逐岗判断，输出 JSON 对象 `{ jobs: [...], summary: {total, matched, target, insufficient} }`，每条含 opening 与 openingStyle；**source 为 favorites 的岗位跳过判断、直接生成开场白**；**目标是 matched 达到 daily_target（默认 100）条**，不足时用更多关键词/来源/翻页补采后重跑，直到达标或当日无新岗位，不要为凑数放宽底线；禁止使用简历中不存在的数字；
5. 整理评审清单 CSV：列固定为 日期,来源,公司,岗位名称,薪资,职位详情(原文),开场白,状态,BOSS在线,链接；职位详情必须是脚本提取的原文，不得由 AI 改写；
6. 模式：按 profile.yaml 的 `mode` 执行——`auto` = 生成后直接发送，不再逐条征求确认；`test` = 先展示评审清单给用户审核，确认后才发送。用户口头要求可临时覆盖；
7. 质量校验：发送前运行 `node scripts/validate-openings.mjs <评审文件>`（JSON 或 CSV），有"❌ [重写]"标记的条目标识后让 AI 重写对应条（只重写不合格的），再进入发送；
8. 发送：运行 `node scripts/send-batch.mjs --review <评审文件>`（url 与 opening 取自同一条记录；send.mjs 自动跳过已沟通岗位并强制身份校验）。**禁止手写发送循环或逐条手工配对**；
9. 批量验证：`node scripts/verify-sends.mjs`。

## 任务二：跟进未读 HR

1. `node scripts/check-followup.mjs <数量>`：筛出消息列表 [送达]+昨天及以前的会话，逐个进会话数 boss 消息；boss 发过消息 → 跳过；boss 从未发 → 待跟进。不依赖本地记录（用户手动投递的岗位同样覆盖）；
2. AI 生成跟进消息：必须与上次内容不同——换一个 JD 要求 + 换一段简历证据；
3. 发送：`node scripts/send.mjs --url <URL> --msg "<跟进消息>"`。

## 硬性规则

- 不调 BOSS 内部 API，只做真实浏览器页面操作；
- 遇验证码/滑块特征立即停止本轮，标记"风控拦截-待人工"，不绕过；
- 当日发送数量达到 `daily_max` 即停止，不重试；
- 同一岗位不重复发送相同内容；跟进内容不与上次重复；
- 薪资、JD、BOSS 在线状态一律使用脚本提取的原文；
- 登录态过期时请用户扫码，AI 不能代替；
- `data/发送记录.csv`、评审清单只做底数据存档，不做状态回写。

## 详细参考

- 命令参数、数据格式、DOM 选择器与踩坑清单：见 [references/runbook.md](references/runbook.md)
- 完整设计文档：项目内 `BOSS直聘AI求职自动化流程.md`
