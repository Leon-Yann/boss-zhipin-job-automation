# BOSS直聘 AI 求职自动化

用"脚本采集 + AI 精筛生成 + 脚本发送"三段式流程，把 BOSS 直聘上每天重复的"搜岗位、读 JD、写打招呼"交给自动化，人工只接管有回复的会话。

## 原理

| 阶段 | 做什么 | 谁来做 |
|---|---|---|
| 一 | 从搜索 / 推荐流 / 收藏批量提取岗位，按 profile.yaml 硬过滤（城市、薪资、排除词、JD 硬伤） | 脚本（零 token） |
| 二 | 逐岗判断匹配度，为匹配岗位生成约 200 字个性化开场白 / 跟进消息 | AI（提示词由 profile.yaml 自动生成） |
| 三 | 真实浏览器点击发送、防重复、风控兜底、校验、记录 | 脚本（零 token） |

## 环境要求

- macOS + Chrome（136+）
- Node.js 22+

## 安装

```bash
npm install
```

## 配置（个人化信息全部在这里）

```bash
cp profile.example.yaml profile.yaml
node scripts/load-config.mjs --check      # 校验配置
node scripts/load-config.mjs --filters    # 查看脚本实际使用的硬过滤规则
node scripts/load-config.mjs --prompt     # 查看生成后的 AI 提示词全文
```

profile.yaml 包含：城市与城市代码、搜索关键词、薪资区间、排除公司/行业、JD 硬伤正则、每日与跟进参数（`daily_target` 指当天筛出并发送的条数；`collect_pool_ratio` 控制采集原始池倍数）、运行模式（`mode: auto` 直接发送 / `test` 先审核）、收藏岗位直投（`favorites_skip_screening`），以及 AI 画像（经历摘要、简历文件、公司入选标准、话术风格）。**修改本文件即可调整全流程，无需改任何脚本。**

`profile.yaml` 与简历文件已被 .gitignore 排除，不会随仓库提交。

## 运行前的浏览器准备

启动带调试端口的 Chrome（登录态常驻，与本机日常 Chrome 互不干扰），**一条命令即可**：

```bash
node scripts/launch-chrome.mjs
```

也可以直接对 AI 说"开始"，让 AI 运行同一脚本。脚本会：

1. 若调试端口已就绪，直接复用并打开 BOSS 直聘；
2. 否则以 `chrome.user_data_dir`（profile.yaml 配置）为独立资料目录启动 Chrome；
3. 打开 `chrome.start_url`（BOSS 直聘），首次使用扫码登录一次，之后登录态常驻。

手动备选：`node scripts/launch-chrome.mjs --open <URL>` 打开指定页面；`--check` 只检查端口状态。

## 日常流程

1. 采集：`node scripts/collect.mjs --source search --queries 电商运营,京东运营 --pages 2 --limit 12`
2. 把 `data/jobs-<日期>.json`（脚本自动合并去重的当日累计）与生成的 AI 提示词一起交给 AI 精筛，产出评审清单；
3. 质量校验：`node scripts/validate-openings.mjs <评审文件>` 检查话术同质化与规则符合度，不合格的先让 AI 重写；
4. 发送：`node scripts/send-batch.mjs --review <评审文件>`（url 与开场白取自同一条记录，自动跳过已沟通岗位并做身份校验）
5. 跟进：`node scripts/check-followup.mjs` 找出待跟进会话，AI 生成不重复的跟进消息后再发送。

详细流程见 [BOSS直聘AI求职自动化流程.md](BOSS直聘AI求职自动化流程.md)。

## 数据与隐私

- 所有数据只在本机浏览器与脚本之间流转，脚本不上传任何数据；
- 发送记录、评审清单、采集原始 JSON 都存放在 `data/`（已 gitignore）；
- 个人真实信息只存在于本机 profile.yaml 与简历文件，仓库只附假数据模板。

## 风险声明

- 自动化操作可能违反 BOSS 直聘平台条款，存在账号被限制/封禁的风险，使用前请自行评估，建议先以小号试水；
- 本项目只做真实浏览器页面的确定性操作，不调用平台内部接口、不绕过验证码、不超每日额度；
- 建议只在个人电脑与家用网络中使用，避免公司网络的上网行为监控。
