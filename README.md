# X 回复筛选与 API 关注

流程在 clone 完成后，以 clone 目标博主为采集对象：读取该博主最近 10 条有回复的帖子，按新到旧逐条用 CommentCrate 导出回复用户 CSV，补充关注/粉丝数并筛选关注；帖子全部处理完后，再用 exporter24 导出博主粉丝 CSV，按同一固定规则筛选关注。关注/粉丝数优先取自 CSV；缺失时用 exporter24 读取，扩展不可用或失败时再用 Playwright 打开候选主页读取。固定规则为两者都大于 50，且较大值不超过较小值的 2 倍。阿拉伯文字筛选和模型评估是可选路径，且只用于帖子回复；粉丝列表没有回复文本。最后通过 X 官方 API 关注每批入选用户。回复内容和公开关注数据不能证明用户所在地或国籍。

## 授权与启动

1. 参考 `.env.example` 配置 X 应用和模型，并将 `X_AUTO_START_LOOP` 设为 `false`。X 开发者控制台的 OAuth 回调须与 `X_REDIRECT_URI` 一致，默认为 `http://127.0.0.1:3000/oauth/callback`。
2. 在一个终端运行 `npm start`，打开 [本机授权与 Cookie 页面](http://127.0.0.1:3000/)，完成账号授权并记下数字 ID；授权和 cookie 导入在同一个页面。运行任务期间保持该服务运行。
3. 在另一个终端运行 `npm run loop -- <账号数字ID>`（可选追加 `--target <博主用户名>`、`--language ar`、`--evaluate`、`--loop-only`）。这是长时流程：必要时 clone → 启动 mirror 子进程监听 → 初始帖子/粉丝 loop → 父进程长时处理延迟回复任务。只想测试单轮 loop 时加 `--loop-only`。程序使用该账号独立资料打开正式版 Google Chrome；手动登录相同的 X 账号，安装 CommentCrate 并授予 X 访问权限。若希望用 exporter24 补充关注/粉丝数，必须在这个账号自己的浏览器资料中安装（只在默认 Chrome 安装不会生效）；未安装时会自动回退到主页读取。
4. 关闭登录窗口；若关闭后终端未继续，按 Enter。程序会用 Playwright 重新打开同一份资料，检查账号和插件，然后自动执行一轮，进度直接显示在当前终端。下一次运行同一账号会复用这些资料；已登录并安装插件的账号会自动跳过登录与安装步骤，直接进入后续自动化流程。

每个账号使用独立的 `.data/browser-profiles/<账号数字ID>`；不同账号需要分别授权和登录。正式版 Chrome 不支持 `--load-extension`，可通过下面的“插件模板”为每个账号资料复制一份已安装的 CommentCrate / exporter24，或手动安装。**单轮任务会实际发送关注请求。**

### 插件模板：每个浏览器实例复制一份

先从一个已经安装好 CommentCrate / exporter24 的 Chrome 资料生成模板：

```sh
npm run profile:template
```

默认从本机 `~/Library/Application Support/Google/Chrome` 复制，只保留：

- `Local State`
- `Default/Preferences`、`Default/Secure Preferences`
- `Default/Extensions`
- `Default/Local Extension Settings`

不会复制 cookie、登录数据、历史记录。模板默认在：

```text
.data/profile-template
```

新账号首次运行 `npm run loop` 时，如果 `.data/browser-profiles/<账号ID>` 不存在，会自动复制模板，然后注入账号 cookie。这样每个账号实例都有自己的一份插件目录和 `Local Extension Settings`，互不影响。

可用环境变量覆盖：

```env
X_PROFILE_TEMPLATE=.data/profile-template
X_PROFILE_TEMPLATE_SOURCE=/path/to/Chrome/user-data
```

模板不存在时仍走原来的手动安装流程。

### 用 cookie 跳过手动登录

已有登录态时，把 cookie 文件放到 `.data/cookies/<账号数字ID>.json`（Netscape 格式的 `cookies.txt` 或复制来的 `Cookie:` 请求头可命名为 `<账号数字ID>.txt`；也可用 `X_COOKIE_FILE` 指定路径）：

```sh
mkdir -p .data/cookies && chmod 700 .data/cookies
chmod 600 .data/cookies/<账号数字ID>.json
```

当该账号尚未标记 `chromeReady` 时，`npm run loop` 会读取并注入 cookie，跳过 Chrome 登录窗口，随后照常校验账号与 CommentCrate。支持 Playwright storage state（`{ "cookies": [...] }`）、浏览器扩展导出的数组、Netscape `cookies.txt` 或 `auth_token=...; ct0=...` 请求头，也可以只写最简单的：

```json
{ "auth_token": "...", "ct0": "..." }
```

只想确认 cookie 能登录、不执行任务时加 `--check-only`（不会发送关注请求）：

```sh
npm run loop -- <账号数字ID> --check-only
```

`auth_token` 与 `ct0` 必须来自同一次登录；其他 x.com / twitter.com cookie 会一并保留。注入的 cookie 会写入该账号的资料目录，供后续运行复用。cookie 只代替登录，**不会安装 CommentCrate**，该资料仍需已安装并授权插件。cookie 等同于账号密码，`.data/` 已被 git 忽略；校验失败时脚本会提示更新文件或删除文件以回到手动登录。

### 批量导入 cookie 与自动执行

启动 `npm start` 后打开：

```text
http://127.0.0.1:3000/
```

授权、账号列表、cookie 导入和自动执行都在同一个页面；`/cookies` 也会返回该页面。

页面会列出已授权账号，并支持一次导入多个账号的 cookie。单个账号可以直接粘贴 Chrome 扩展导出的 cookie 数组，账号 ID 会从 `twid`（`u%3D<id>`）自动识别：

```json
[
  { "domain": ".x.com", "name": "auth_token", "value": "...", "httpOnly": true },
  { "domain": ".x.com", "name": "twid", "value": "u%3D1234567890" },
  { "domain": ".x.com", "name": "ct0", "value": "..." }
]
```

多账号导入时，每项提供 `accountId` 或 `username`，以及 `cookie`：

```json
[
  {
    "accountId": "1234567890",
    "cookie": { "auth_token": "...", "ct0": "..." }
  },
  {
    "username": "alice",
    "cookie": "auth_token=...; ct0=...;"
  }
]
```

导入后会写入 `.data/cookies/<账号ID>.json`（权限 0600），并把该账号的 `chromeReady` 清掉，下次运行会重新校验 cookie 和 CommentCrate。cookie 导入只负责登录，**不会安装 CommentCrate**。

页面上的“自动选择并执行”会依次检查有 cookie 的已授权账号，使用第一个仍能登录的账号执行一轮采集。自动检查使用 `--check-only`，不会发送关注请求；单轮采集写入 Outbox，由主 loop 的 worker 消费。后台自动任务的日志在 `.data/auto-run.log`。所有账号都检查失败时会退出。

`X_AUTO_START_LOOP=true` 可以启用旧版后台账号实例。切换到前台命令前，先用 `npm run account -- stop <账号数字ID>` 停止该账号的旧实例，避免资料目录被占用。

同一账号优先复用已打开且空闲的实例：再次授权或执行 `npm run account -- run <账号数字ID>` 可以启动下一轮。`npm run account -- status <账号数字ID>` 查看状态及错误；`npm run account -- stop <账号数字ID>` 关闭该账号的实例，保留其资料目录。实例只复用给绑定的账号，不在账号间共享登录状态。

授权申请 `tweet.read`、`users.read`、`follows.read`、`follows.write`、`tweet.write`、`media.write` 和 `offline.access`。已有账号如缺少权限需重新授权。账号相关状态统一保存在 `.data/accounts.sqlite` 的账号表：自增主键、X 账号数字 ID（uuid）、用户名（索引）、是否已 clone、clone 来源账号信息（用户名/显示名/数字 ID/完成时间）、历史关键词字段（keywords）、是否已在账号资料 Chrome 登录并安装插件、是否已认证，以及 access / refresh 令牌（AES-GCM 加密，密钥在 `.data/key`）。二者位于同一机器，保护范围限于避免意外查看。服务只监听本机，不要将其公开到网络。用户查询和关注会消耗 API 额度，具体权限、费用及限额以 X 开发者控制台为准。

## 单轮调试

正常执行统一使用长时 `npm run loop`。只测试单轮阶段时加 `--loop-only`：

```sh
npm run loop -- <账号ID> --loop-only [--target <博主用户名>] [--language ar] [--evaluate] [--yes]
```

`--loop-only` 不 clone、不启动 mirror、不进入长时模式。恢复任务：

```sh
npm run loop -- <账号ID> --loop-only --resume <任务ID>
```

独立窗口为多账号隔离提供基础，但当前帖子与用户去重和 X 熔断仍为全局状态，因此同一时间只执行一轮；尚不支持多账号并行。不同账号可同时准备各自的浏览器资料。

单轮 loop 使用账号的 clone 目标作为博主（`--blogger` 仅作为未 clone 账号的手动兜底）。流程：

1. 读取博主最近 10 条帖子，按新到旧排序，跳过没有回复的帖子。
2. 对每条帖子：CommentCrate 导出回复 CSV → exporter24/主页补充关注/粉丝数 → 固定规则筛选 → 可选语言/模型评估 → 关注入选用户。
3. 所有帖子处理完后：exporter24 导出博主粉丝 CSV → 同一固定规则筛选 → 关注入选用户。

固定规则：关注数和粉丝数都大于 50，且较大值不超过较小值的 2 倍。阅读会串行并带随机延迟。`--language ar` 只影响帖子回复用户；`--evaluate` 只评估回复用户，粉丝列表不做模型评估。关注时优先使用 CSV 的用户数字 ID，缺失时才批量解析用户名。**该命令会实际发送关注请求。** 粉丝导出依赖 exporter24 的登录/额度；大粉丝量账号可能超时。

### 关注 Outbox

筛选结果按账号和目标 ID 去重写入 `.data/following.sqlite` 中的 Outbox。正常主 `npm run loop` 启动后台 worker，默认自动执行：每批最多 20 人，批次间隔至少 15 分钟，每账号最近 24 小时最多 400 次本程序关注尝试。请求限流或达到本程序配额会保留待处理项；结果不明确或处理中断则转为待核实，不自动重发。网页或其他应用的关注不会计入本程序配额。旧的 `--yes` 保留兼容，默认已经无需确认。

需要每批手动确认时，主 loop 添加 `--confirm-follow`；非交互终端无法确认时 worker 退出，候选人保留在 Outbox。单独的 `--loop-only`、`--no-mirror`、页面单轮任务结束后不会持续运行 worker，队列会保留，启动主 loop 后继续处理。主 loop 或 worker 停止时不会清空队列。

```sh
node scripts/follow/outbox-control.ts status <账号ID>
# 人工核实后，先用 loop:health resolve-api-follow 处理 uncertain，再重新排队
node scripts/follow/outbox-control.ts retry <账号ID> <目标ID>
```

重启 `npm start` 以加载服务端配额改动。仅本程序已记录的请求计入配额；限制无法保证符合 X 自动关注规则。


补充到的关注/粉丝数会写回原 CSV 同目录的 `*-enriched.csv`，新增 `followersCount`、`followingCount` 两列；筛选和关注使用同一份内存数据。

模型配置为 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`，仅在使用 `--evaluate` 时需要。结果和任务状态保存在 `.data/loop-runs`、`.data/loop.sqlite`，API 关注记录在 `.data/following.sqlite`。任务可从断点恢复：

```sh
npm run loop -- <账号ID> --loop-only --resume <任务ID>
npm run loop:health
```

旧的浏览器关注任务不会自动迁移为 API 任务，需要先核对其已关注和结果不明的用户。

## 自动选择 clone 目标

`--target` 优先：

```sh
npm run loop -- <账号ID> --target <博主用户名>
```

未指定 `--target` 且账号尚未 clone 时，使用 X API 的 `users/search` 搜索时尚相关博主，再逐一检查：

- 粉丝数 > `CLONE_TARGET_MIN_FOLLOWERS`（默认 1000）
- 最近 3 条非转推/非回复帖子中，至少 `CLONE_TARGET_REQUIRED_POSTS` 条（默认 2）回复数 >= `CLONE_TARGET_MIN_REPLIES`（默认 50）

第一个满足条件的博主会被选为 clone 目标，并持久化。可用参数：

```sh
CLONE_TARGET_MIN_REPLIES=50
CLONE_TARGET_MIN_FOLLOWERS=1000
CLONE_TARGET_REQUIRED_POSTS=2
CLONE_TARGET_MAX_CANDIDATES=40
FASHION_SEARCH_QUERIES=fashion,fashion blogger,fashion influencer,ootd,street style
```

账号已经 clone 时不会重新搜索，直接使用 `copied_from_username`；传入不同 `--target` 会报错。

## 长时 loop（clone → mirror 子进程 + 延迟回调）

```sh
npm run loop -- <账号ID> [--target <博主用户名>] [--cookie <文件>] [--language ar] [--evaluate] [--loop-only] [--confirm-follow] [--mirror-once|--no-mirror] [--check-only]
```

行为：

1. 账号未 clone：用 `--target` 执行 clone，完成后写入账号表并持久化目标。
2. 账号已 clone：跳过 clone，直接使用账号表里的 `copied_from_username`；
   若传入不同的 `--target` 会报错，不会重新 clone 或更换目标。
3. **先启动 mirror 子进程**，持续监听目标新帖并立即镜像发布；子进程异常退出 5 秒后自动重启。
4. 父进程执行初始 loop：最多 10 条有回复的最近帖子 + 博主粉丝列表，每批筛选后关注。
5. 初始 loop 结束后，父进程保持长时运行，每隔 `MIRROR_REPLY_SCHEDULER_MS` 检查延迟回复任务：
   - 到期任务执行 `loop --loop-only --post <原帖>`，只处理该帖回复，不处理粉丝
   - 任务串行执行，避免和当前 loop 争用账号
   - 失败最多重试 3 次
6. mirror 子进程只负责监听/镜像/登记任务；延迟任务由父 loop 执行。
7. `--mirror-once`：mirror 只回填 3 条，初始 loop 后退出，不进入长时模式。
8. `--no-mirror`：不启动 mirror，只跑一次初始 loop 后退出。
9. `--loop-only`：只跑一次 loop，不 clone、不启动 mirror、不进入长时模式，用于测试。
10. `--check-only`：只检查登录和插件，并打印 clone 状态/持久化目标，不执行 clone、loop 或 mirror。

持久化位置：

- clone 状态与目标：`.data/accounts.sqlite` 的 `cloned`、`copied_from_username`、`copied_at` 等字段
- mirror 目标、水位线和延迟回复任务：`.data/mirror.sqlite`
- loop 任务/批次状态：`.data/loop.sqlite` 和 `.data/loop-runs/*.json`

## 镜像发帖（准实时 hook）

把某个目标用户的**新发帖**复制文本与图片、用另一个授权账号发新帖（视频/GIF 跳过）。目标新帖通过 X API 获取（REST 时间线或 filtered stream），发帖和图片上传也全部走 X API；脚本只复制 API 返回的文本与图片，不使用浏览器页面抓取。X 不提供面向任意第三方的“发帖即回调”webhook，这里启动时先回填目标最新 3 条，随后优先用 **filtered stream**（一条长连接、X 实时推送，需 API 套餐支持 filtered stream）；连不上或套餐不支持时自动回退到 REST 轮询（间隔默认 60 秒，可用 `MIRROR_INTERVAL_MS` 调整，`--poll` 强制轮询，`--once` 只跑一次；`--backfill-only` 只复制最新 3 条然后退出，适合测试）。每条实际镜像帖之间随机等待 5–10 秒，可用 `MIRROR_POST_GAP_MIN_MS`、`MIRROR_POST_GAP_MAX_MS` 调整；轮询间隔和每次 API 请求也有随机抖动，可用 `MIRROR_POLL_JITTER_MS`、`MIRROR_REQUEST_JITTER_MS` 调整。状态持久化在 `.data/mirror.sqlite`，重启后从水位线继续，不会重复发同一帖。

### 新帖延迟回复爬取

镜像发帖成功后，会立即把目标原帖登记为一条延迟回复爬取任务。默认 **5 小时后**执行：

```sh
MIRROR_REPLY_DELAY_MS=18000000   # 5 小时，单位毫秒
```

完整 `npm run loop` 中由父 loop 执行；单独运行 `npm run mirror` 时由 mirror 自己的调度器执行。执行时启动：

```sh
npm run loop -- <发帖账号ID> --loop-only --post <目标原帖链接> --target <博主>
```

只处理这一条帖子的回复，不处理粉丝列表。筛选结果写入关注 Outbox；由主 loop 的 worker 分批处理。单独运行 mirror 时需另行启动主 loop 来处理 Outbox。

相关参数：

```sh
MIRROR_REPLY_DELAY_MS=18000000     # 延迟多久执行，默认 5 小时
MIRROR_REPLY_SCHEDULER_MS=60000    # 调度器检查间隔，默认 60 秒
MIRROR_REPLY_RETRY_MS=600000       # 失败重试间隔，默认 10 分钟
```

- 任务持久化在 `.data/mirror.sqlite` 的 `mirror_reply_jobs` 表
- 失败最多重试 3 次
- `--backfill-only` 和 `--once` 不启动调度器，任务会保留到下一次持续监听
- 单独运行 mirror 时不会启动关注 Outbox worker；队列保留到主 loop 启动。


```sh
# 目标用户发新帖后，复制文本用发帖账号发新帖（发帖账号须具备 tweet.write）
npm run mirror -- <目标用户名> <发帖账号数字ID>
npm run mirror -- list
npm run mirror -- remove <目标用户名>
```

发帖账号需先完成 X 授权并授予 `tweet.write` 与 `media.write`。程序按目标用户名解析数字 ID，**启动时先回填目标最新 3 条帖子**，随后优先用 filtered stream 实时监听新帖、失败回退 REST 轮询（`since_id` 只取新帖、排除转发）。每条帖子复制文本（截断到 280 字符）与图片（最多 4 张，jpg/png/webp，≤5 MB），**视频和 GIF 跳过**；失败的帖子最多重试 3 次后跳过，收到 429 冷却 15 分钟。**复制原文内容有被 X 判为垃圾/冒充的风险**，请自行评估并控制频率。

## 失败与冷却

采集阶段遇到 X 429 会进入已有的冷却和探测流程。Outbox 关注遇到 429 会停止当前批次并保留条目，在下次批次间隔后再尝试；结果不明记录为 `manual`，需要先核实。插件导出中断也需先核实。

人工核实 API 关注的实际状态后，可记录结果（不发送请求）：

```sh
npm run loop:health -- resolve-api-follow <授权账号数字ID> <目标账号数字ID> following
# 其他结果：pending、not_following
```

旧浏览器关注记录仍可用 `resolve-follow <当前用户名> <目标用户名> following|pending|not_following` 核实。若确需人工重置熔断，可执行 `npm run loop:health -- reset x` 或 `-- reset llm`；重置本身不会启动任务。

## 备用与测试

脚本和测试均使用 TypeScript，Node.js 22.18 及以上版本可直接运行。`npm run typecheck` 检查源码、脚本和测试；当前配置尚未开启 TypeScript 严格模式。`npm test` 使用本地模拟接口，不访问真实 X API；浏览器测试可用 `XBOT_BROWSER_TEST=1 npm test` 启用。

## 脚本目录

- `scripts/account/`：账号实例、状态与登录检查。
- `scripts/browser/`：浏览器连接、启动和 exporter24 计数读取。
- `scripts/clone_user/`：独立的账号资料复制，使用 `npm run clone_user -- <目标用户名> <子账号资料名>`，可加 `--cookie <文件>`、`--dry-run`、`--update`。复制头像、显示名称、完整简介和横幅；`--update` 只刷新资料、不改用户名，已 clone 的账号也可用。clone 完成后，loop 默认使用该来源博主采集帖子回复。
- `scripts/mirror/`：目标发帖镜像（准实时 hook）。使用 `npm run mirror -- <目标用户名> <发帖账号数字ID>` 注册并持续轮询目标新帖，复制文本用发帖账号发新帖；`npm run mirror -- list` 查看，`npm run mirror -- remove <目标用户名>` 移除。
- `scripts/follow/`：关注操作。
- `scripts/loop/`：单轮任务、队列和恢复。
- `scripts/replies/`：回复导出和筛选。
