# BOSS直聘 AI 求职自动化

把 BOSS 直聘上每天重复的"搜岗位、读 JD、写打招呼、跟进未读"交给自动化：脚本负责采集和发送，AI 负责筛选和写话术，你只接管有回复的会话。

> ⚠️ **先读这一条**：本项目会真实操作你的 BOSS 直聘账号。使用前请阅读文末[风险声明](#风险声明)，建议先用小号、先用测试模式跑通。

## 它怎么工作（30 秒理解）

| 阶段 | 做什么 | 谁来做 |
|---|---|---|
| 一 采集 | 从搜索 / 推荐流 / 收藏批量提取岗位，按 profile.yaml 硬过滤（城市、薪资、排除词、JD 硬伤） | 脚本（不消耗 token） |
| 二 精筛与生成 | 逐岗判断匹配度，为匹配岗位生成个性化开场白 | **AI**（需要你提供一个 AI 助手，见下） |
| 三 发送与跟进 | 真实浏览器发送、防重复、风控兜底、校验、记录 | 脚本（不消耗 token） |

**你需要提供的东西**：一台 Mac、Chrome、Node.js、一个 BOSS 直聘账号，以及一个 AI 助手（Codex / ChatGPT / DeepSeek / Claude 任一）。

---

## 快速开始（约 10 分钟）

### 第 1 步：准备环境

```bash
node -v          # 需要 22+
npm install      # 安装依赖
```

### 第 2 步：填写你的配置（最重要）

```bash
cp profile.example.yaml profile.yaml
```

然后编辑 `profile.yaml`，**必改 3 处**：

1. `city` / `city_code`：你的城市和 BOSS 直聘城市代码（例子里有上海 101020100）；
2. `search_keywords`：你的求职关键词，如 `电商运营, 京东运营`；
3. `profile.resume_file`：**换成你自己的简历文件**（如 `./docs/my-resume.md`），并把真实简历放到该路径。⚠️ 不换的话，AI 会拿示例假简历写开场白。

其余字段（薪资、排除公司、每日目标、话术风格等）先按示例理解，之后随时可改。改完校验：

```bash
node scripts/load-config.mjs --check
```

### 第 3 步：启动调试版 Chrome 并登录

```bash
node scripts/launch-chrome.mjs
```

会打开一个独立 Chrome 窗口并进入 BOSS 直聘，**扫码登录一次**。登录态保存在 `profile.yaml` 的 `chrome.user_data_dir` 指定目录，之后不用重复扫码。

### 第 4 步：选择你的使用方式

#### 方式 A：Codex Skill 全自动（推荐，最省事）

如果你用 OpenAI 的 Codex 桌面应用：

```bash
node scripts/install-skill.mjs
```

然后新建一个对话，说：

> 开始今天的 BOSS 直聘任务

Codex 会按技能里的手册自动完成：采集 → 精筛 → 生成开场白 → 发送 → 跟进。你只需要在它需要授权或扫码时确认。

#### 方式 B：手动配合任意 AI（不用 Codex 也能用）

每天按下面 5 步操作：

**① 采集**

```bash
node scripts/collect.mjs --source search --queries 电商运营,京东运营 --pages 2
```

来源还有 `recommend`（推荐流）和 `favorites`（你的收藏）；目标条数默认按 `daily_target × collect_pool_ratio` 自动执行，采集结果合并进 `data/jobs-<日期>.json`。

**② 让 AI 精筛并生成开场白**

```bash
node scripts/load-config.mjs --save-prompt data/ai-prompt.md
```

把两个文件的内容一起发给你的 AI 助手（ChatGPT / DeepSeek / Claude 等）：

- `data/jobs-<日期>.json`（当天采集的岗位）
- `data/ai-prompt.md`（完整指令：你的画像、判断标准、话术规则、输出格式）

让 AI"严格按指令输出 JSON"。把它的回复**原样**保存为 `data/<日期>-review.json`（不要包 Markdown 代码块）。岗位多时可以**分批发**（每批 40-60 条），AI 每次输出一段，最后把各段合并成一个 JSON 数组；指令里的 summary 会告诉你当前达到多少条目标、是否不足。

**③ 话术质检**

```bash
node scripts/validate-openings.mjs data/<日期>-review.json
```

有"❌ [重写]"标记的，把对应岗位和提示词再发给 AI 重写，只改不合格的。

**④ 发送**

```bash
node scripts/send-batch.mjs --review data/<日期>-review.json
```

脚本自动跳过已沟通岗位、校验聊天对象身份、按拟人节奏发送并记录。

**⑤ 跟进未读**

```bash
node scripts/check-followup.mjs 20
```

把输出的"待跟进清单"连同上次消息发给 AI，让它按"换角度、不重复"生成跟进消息，再保存成 JSON 用第 ④ 步发送。

---

## 配置说明（profile.yaml 字段速查）

| 类别 | 字段 | 说明 |
|---|---|---|
| 基本信息 | user_name / city / city_code | 称呼、城市名、BOSS 直聘城市代码 |
| 目标岗位 | target_jobs / search_keywords | 目标方向、采集关键词 |
| 硬过滤 | salary_strict / salary_relaxed | 严格薪资档与放宽档（K） |
| | exclude_keywords / exclude_companies | 排除公司/行业关键词、已知公司名单 |
| | jd_hard_exclude | JD 硬伤正则（如"需base其他城市"） |
| | favorites_skip_screening | 收藏岗位跳过筛选直接沟通 |
| 每日与跟进 | daily_target / daily_max / collect_pool_ratio | 每日目标（筛出并发送的条数）、上限、采集池倍数 |
| | followup_* | 跟进间隔、最长天数、每人最多消息数 |
| | send_interval_seconds | 批量发送随机间隔（拟人节奏） |
| 运行模式 | mode | `test`=先审核后发送；`auto`=直接发送（建议先 test） |
| AI 画像 | direction / summary / resume_file | 求职方向、经历摘要、简历文件路径 |
| | company_standards / opening_style / followup_style | 公司入选标准、话术风格 |
| 浏览器 | chrome.* | Chrome 路径、调试端口、资料目录、启动 URL |

完整字段见 `profile.example.yaml` 内注释；修改后无需改动任何脚本。

## 目录结构

```
├── profile.yaml            # 你的配置（gitignore，不进仓库）
├── profile.example.yaml    # 配置模板（假数据）
├── prompts/screening.md    # AI 精筛与开场白的提示词模板
├── scripts/                # 全部脚本（采集/校验/发送/跟进/安装技能）
├── skill/boss-zhipin-job/  # Codex Skill 源文件
├── data/                   # 运行数据：发送记录、评审清单、采集累计（gitignore）
└── docs/resume.example.md  # 示例简历（换成你自己的）
```

## 数据与隐私

- 所有数据只在本机浏览器与脚本之间流转，脚本不上传任何数据；
- `profile.yaml`、真实简历、`data/` 下所有运行数据都被 .gitignore 排除，不会提交到仓库；
- 仓库只附假数据模板，克隆后填写你自己的信息即可。

## 常见问题

**第一次运行我要做哪几件事？**
准备环境 → 复制并填写 profile.yaml（含换简历）→ 启动 Chrome 并扫码登录 → 选方式 A 或 B 跑一遍测试模式。

**我的简历放哪？**
放到项目内任意位置（如 `docs/my-resume.md`），把 `profile.resume_file` 指向它。

**发送前可以人工审核吗？**
可以。`mode: test` 时 AI 只产出评审清单，确认后才发送；确认质量后再改 `mode: auto`。

**会不会重复骚扰已沟通过的 boss？**
不会。采集和发送两层都会自动排除"继续沟通"的岗位。

**Windows / Linux 能用吗？**
脚本基于 Chrome 调试端口，理论可用，但 `chrome.executable` 路径需自己改，目前仅在 macOS 实测。

**会不会封号？**
见下方风险声明。任何自动化都有风险，本项目做了保守设计（真人节奏、不绕过验证码、额度内操作），但无法保证 100% 安全。

## 风险声明

- 自动化操作可能违反 BOSS 直聘平台条款，存在账号被限制/封禁的风险，使用前请自行评估，建议先以小号试水；
- 本项目只做真实浏览器页面的确定性操作，不调用平台内部接口、不绕过验证码、不超每日额度；
- 建议只在个人电脑与家用网络中使用，避免公司网络的上网行为监控；
- 本项目按 MIT 协议开源，使用后果自负。

详细设计文档见 [BOSS直聘AI求职自动化流程.md](BOSS直聘AI求职自动化流程.md)。
