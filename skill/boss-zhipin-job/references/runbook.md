# BOSS直聘自动化 运行手册

## 目录

1. 环境与依赖
2. 脚本清单（生产 / 诊断）
3. 配置（profile.yaml）
4. 命令详解
5. 数据格式
6. DOM 选择器依赖
7. 踩坑与规避
8. 已知限制与待办

## 1. 环境与依赖

- Node ≥ 22（建议 25+），需要全局 fetch / WebSocket；
- 唯一依赖：`yaml`（项目根目录 `npm install` 一次）；
- Chrome：调试端口 9222，独立资料目录 = profile.yaml 的 `chrome.user_data_dir`（登录态常驻于此，关闭窗口/重启电脑不丢）；
- 沙箱限制：脚本访问 `127.0.0.1:9222` 需提权；GUI 启动 Chrome 需用户授权；
- 运行前用 `node scripts/launch-chrome.mjs --check` 确认端口在线。

## 2. 脚本清单

**生产脚本（主流程使用）**

| 脚本 | 作用 |
|---|---|
| `load-config.mjs` | 校验/查看配置与提示词（`--check` / `--filters` / `--prompt` / `--save-prompt <路径>`） |
| `launch-chrome.mjs` | 启动/复用调试 Chrome（`--open <URL>` / `--check`） |
| `collect.mjs` | 采集 + 硬过滤（`--source search\|recommend\|favorites`、`--queries "a,b"`、`--pages N`、`--limit N`、`--max-results N`；默认目标 = profile.yaml 的 daily_target；每轮自动合并进当日累计文件） |
| `send.mjs` | 发送 + 查重 + 风控兜底 + 校验（`--url`、`--msg`、`--wait 秒`） |
| `send-batch.mjs` | 通用批量发送：从评审文件逐条发送（url+opening 同记录），自动分类统计、断点续跑（`--review`、`--limit`、`--resume-log`、`--force`、`--dry-run`） |
| `filter-sent.mjs` | 精筛前双保险：从当日 jobs 文件剔除已发送 URL（`--date`、`--dry-run`） |
| `validate-openings.mjs` | 开场白质量校验：长度/禁用词/含数据/结尾同质/两两相似度/风格分布（`node validate-openings.mjs <JSON或CSV> [--threshold 0.4]`） |
| `check-unread.mjs` | 消息列表级筛选：[送达] + 昨天及以前（参数为数量） |
| `check-followup.mjs` | 候选逐个进会话数 boss 消息 → 输出待跟进/跳过 |
| `verify-sends.mjs` | 一次性批量验证发送结果并回写状态 |

## 3. 配置（profile.yaml）

- 硬过滤：`city` / `city_code`、`salary_strict` / `salary_relaxed`（单位 K）、`exclude_keywords`、`exclude_companies`、`jd_hard_exclude`（`{city}` 会被替换为城市名）、`daily_target` / `daily_max`、`collect_pool_ratio`（原始池 = daily_target × 倍数）、`mode`（auto=直接发送 / test=先审核）、`favorites_skip_screening`（收藏岗位跳过筛选直投）、`followup_*`、`send_interval_seconds`；
- AI 画像：`profile.direction` / `summary` / `resume_file` / `company_standards` / `opening_style` / `followup_style`；
- 浏览器：`chrome.executable` / `debug_port` / `user_data_dir`（支持 `~` 展开）/ `start_url`；
- 修改配置无需改脚本；AI 判断与话术中的一切数据以简历文件为准，摘要仅供定位卖点（提示词模板已内置该优先级规则）。

## 4. 命令详解

### collect.mjs

```bash
node scripts/collect.mjs --source search --queries 电商运营,京东运营 --pages 2
node scripts/collect.mjs --source search --queries 电商运营 --pages 2 --limit 50 --max-results 30
node scripts/collect.mjs --source recommend
node scripts/collect.mjs --source favorites
```

- 输出：`data/raw-<source>.json`（含完整 JD 原文、真实薪资、BOSS 在线、公司信息）；
- `daily_target`（默认 100）= 当天筛出并发送的条数；不传 `--limit` / `--max-results` 时，采集池目标 = `daily_target × collect_pool_ratio`（默认 300）；单次运行最多产出 `--max-results` 条，凑满原始池需多关键词 / 多来源 / 翻页迭代；
- **不覆盖丢失**：每轮结果自动合并进 `data/jobs-<日期>.json`（当日全来源累计，AI 精筛输入）和 `data/raw-<来源>.json`（同来源累计），均按岗位 URL 去重；`--no-merge` 可只打印不写文件；
- 内置硬过滤：城市、排除关键词/公司名单、薪资区间、JD 硬伤正则、"继续沟通"按钮排除、URL 去重、收藏页混合卡片过滤；
- `--source favorites`：若 `favorites_skip_screening: true`，跳过城市/薪资/排除词/JD 硬伤等全部过滤，但仍排除"继续沟通"岗位与重复 URL；
- **已沟通岗位前置排除**：采集进详情页时读取按钮文本，"继续沟通"→ 不收录；合并当日累计时对照发送记录.csv 剔除已发送 URL——已沟通岗位不会进入 AI 精筛，不浪费生成 token；
- 推荐流翻页 = 滚动加载；搜索/收藏 = page 参数。

### send.mjs

```bash
node scripts/send.mjs --url https://www.zhipin.com/job_detail/xxx.html --msg "4年家电电商运营..."
```

- 发送前按 URL+内容查重；发送中检测验证码/滑块特征，命中即停并标记；
- 确定性校验：输入框清空且消息前 14 字出现在聊天记录；
- 按钮为"继续沟通"（已沟通过）→ 默认跳过（exit 4），`--force` 可强制；
- 发送前强制身份校验：从岗位页提取期望公司与 BOSS 姓名，与打开的聊天头部比对，不匹配即中止（exit 3）；
- 成功后追加到 `data/发送记录.csv`。

### send-batch.mjs

```bash
node scripts/send-batch.mjs --review data/2026-08-11-review.json
node scripts/send-batch.mjs --review data/2026-08-11-评审清单.csv --limit 50 --resume-log data/batch-sent.log
```

- url 与 opening 取自同一条记录，杜绝手工配对；AI 只允许用本脚本发送，禁止自写发送循环；
- 统计：成功 / 已沟通跳过 / 身份不符跳过 / 失败；风控即停；`--resume-log` 断点续跑。

### check-followup.mjs

```bash
node scripts/check-followup.mjs 10
```

- 列表级：[送达] + 昨天及以前 → 候选；
- 会话级：进会话数 boss 消息（系统消息剔除后计数）；boss ≥1 条 → 跳过；boss = 0 → 待跟进；
- 性能：一次导航 + 轮询切换，9 条约 85 秒，50 条预估 8 分钟。

## 5. 数据格式

**发送记录.csv**（5 列，旧 4 列格式兼容）：

```text
时间,岗位URL,消息内容,对方(姓名+职位),状态
```

状态取值：`已送达` / `已送达确认` / `风控拦截-待人工` / `待确认`。

**评审清单.csv**（10 列）：

```text
日期,来源,公司,岗位名称,薪资,职位详情(原文),开场白,状态,BOSS在线,链接
```

**raw-<source>.json** 字段：`source / href / jobTitle / company / salary / relaxed / bossOnline / companyInfo / jd / cardText`。

**jobs-<日期>.json**：当日全来源累计（AI 精筛的正式输入），字段同 raw 文件，脚本自动按 URL 去重合并。

**AI 精筛输出（对话内）**：JSON 对象 `{ jobs: [...], summary: {total, matched, target, insufficient} }`；jobs 每条含 `opening` 与 `openingStyle`（成果型/痛点回应型/洞察型/价值型）。

## 6. DOM 选择器依赖

| 元素 | 选择器 |
|---|---|
| 聊天输入框 | `[contenteditable].chat-input` |
| 发送按钮 | `.btn-send` |
| 消息列表容器 | `.friend-content` |
| 会话头部（对方身份） | `.chat-conversation` |
| 消息气泡 | `li.message-item` |
| 系统消息标记 | `item-system` 类 |
| 沟通按钮 | `.btn-startchat` |
| BOSS 在线标签 | `.boss-online-tag` |
| JD 文本区 | `.job-sec-text` |

页面改版后需同步更新这些选择器。

## 7. 踩坑与规避

- Chrome 在后台时 CDP 输入事件不派发 → 发送/跟进脚本已内置 `Page.bringToFront()`；
- 会话列表项合成 click 无效 → 必须真实鼠标事件（mousePressed + mouseReleased）+ 滚动到视口；
- 系统消息（"与职位竞争者PK情况""附件简历请求已发送""对方已同意，您的附件简历已发送"等）会被误计为 boss 消息 → 按 `item-system` 类 + 内容特征排除（已与人工核对 9 条一致）；
- 列表页薪资是字体反爬 → 薪资必须进详情页抓明文；
- "继续沟通"按钮 = 该 boss/岗位已沟通过 → 排除；同一岗位 URL 去重；
- web 端无岗位发布时间；BOSS"近3天活跃"粒度不可得，只有"在线"标签；
- 薪资过滤默认：放宽档下限 + 严格档下限（如低≥15 且高≥20，配置驱动）；
- 跟进判断不依赖本地记录——用户手动投递的岗位同样覆盖。

## 8. 已知限制与待办

- 自动模式一键编排（形态 A）未做：当前为对话内逐步执行；
- 生成方式决策点未定：对话内 vs API（无人值守需 API）；
- 城市硬伤过滤已实现，待真实 JD 实测；
- 发送节奏、跟进次数等已按 profile.yaml 参数执行。
