# X 回复筛选与 API 关注

流程在 clone 完成后，以 clone 来源博主为采集对象：打开该博主主页，选择回复最多的新帖子，用 CommentCrate 导出回复用户 CSV。候选用户的关注数和粉丝数优先取自 CommentCrate 导出的 CSV；CSV 没有这两列时，优先用已安装的 exporter24 扩展读取，扩展不可用或失败时再用 Playwright 逐个打开候选主页读取。两种方式都不调用 X API 查询。固定规则为两者都大于 50，且较大值不超过较小值的 2 倍。阿拉伯文字筛选和模型评估是可选路径。最后通过 X 官方 API 关注入选用户。回复内容和公开关注数据不能证明用户所在地或国籍。

## 授权与启动

1. 参考 `.env.example` 配置 X 应用和模型，并将 `X_AUTO_START_LOOP` 设为 `false`。X 开发者控制台的 OAuth 回调须与 `X_REDIRECT_URI` 一致，默认为 `http://127.0.0.1:3000/oauth/callback`。
2. 在一个终端运行 `npm start`，打开 [本机授权页面](http://127.0.0.1:3000/)，完成账号授权并记下数字 ID。运行任务期间保持该服务运行。
3. 在另一个终端运行 `npm run loop -- <账号数字ID>`（可选追加 `--blogger <博主用户名>`、`--language ar`、`--evaluate`）。程序使用该账号独立资料打开正式版 Google Chrome；手动登录相同的 X 账号，安装 CommentCrate 并授予 X 访问权限。若希望用 exporter24 补充关注/粉丝数，必须在这个账号自己的浏览器资料中安装（只在默认 Chrome 安装不会生效）；未安装时会自动回退到主页读取。
4. 关闭登录窗口；若关闭后终端未继续，按 Enter。程序会用 Playwright 重新打开同一份资料，检查账号和插件，然后自动执行一轮，进度直接显示在当前终端。下一次运行同一账号会复用这些资料；已登录并安装插件的账号会自动跳过登录与安装步骤，直接进入后续自动化流程。

每个账号使用独立的 `.data/browser-profiles/<账号数字ID>`；不同账号需要分别授权和登录。正式版 Chrome 不会通过旧的 `X_COMMENTCRATE_EXTENSION_PATH` 参数自动加载扩展，需在账号浏览器中手动安装。**单轮任务会实际发送关注请求。**

`X_AUTO_START_LOOP=true` 可以启用旧版后台账号实例。切换到前台命令前，先用 `npm run account -- stop <账号数字ID>` 停止该账号的旧实例，避免资料目录被占用。

同一账号优先复用已打开且空闲的实例：再次授权或执行 `npm run account -- run <账号数字ID>` 可以启动下一轮。`npm run account -- status <账号数字ID>` 查看状态及错误；`npm run account -- stop <账号数字ID>` 关闭该账号的实例，保留其资料目录。实例只复用给绑定的账号，不在账号间共享登录状态。

授权申请 `tweet.read`、`users.read`、`follows.read`、`follows.write`、`tweet.write`、`media.write` 和 `offline.access`。已有账号如缺少权限需重新授权。账号相关状态统一保存在 `.data/accounts.sqlite` 的账号表：自增主键、X 账号数字 ID（uuid）、用户名（索引）、是否已 clone、clone 来源账号信息（用户名/显示名/数字 ID/完成时间）、历史关键词字段（keywords）、是否已在账号资料 Chrome 登录并安装插件、是否已认证，以及 access / refresh 令牌（AES-GCM 加密，密钥在 `.data/key`）。二者位于同一机器，保护范围限于避免意外查看。服务只监听本机，不要将其公开到网络。用户查询和关注会消耗 API 额度，具体权限、费用及限额以 X 开发者控制台为准。

## 其他单轮启动方式

手动模式可启动 `npm run browser`，在正式版 Google Chrome 的独立资料目录（`.data/manual-chrome-profile`）中登录 X 并安装、启用 CommentCrate；另开终端启动 `npm start`，再运行：

```sh
npm run test-loop -- --blogger <博主用户名>
```

也可使用 `npm run test-loop -- --account-id <数字ID> --username <用户名> --cdp-port <端口>` 指定账号及浏览器，账号一旦绑定到任务，恢复时不能换账号。新增的可选路径参数为 `--blogger <博主用户名>`、`--language ar` 和 `--evaluate`。单个已授权账号无需指定 ID；有多个时可在 `.env` 中设置 `X_FOLLOW_ACCOUNT_ID`。配置通过 `dotenv` 加载，任务 ID、账号和端口等运行状态通过参数传递。

独立窗口为多账号隔离提供基础，但当前帖子与用户去重和 X 熔断仍为全局状态，因此同一时间只执行一轮；尚不支持多账号并行。不同账号可同时准备各自的浏览器资料。

单轮任务从 clone 来源博主（或用 `--blogger` 指定）的主页选择回复最多且未处理的帖子，导出回复并解析用户。默认只按固定规则筛选：关注数和粉丝数优先从 CSV 读取；缺失时优先用 exporter24 扩展批量读取，扩展不可用或连续失败时回退到逐个打开候选主页读取。要求两者都大于 50、且较大值不超过较小值的 2 倍。读取会限制为串行并带随机延迟。`--language ar` 额外只保留含阿拉伯文字的回复用户，`--evaluate` 再结合帖子内容对剩余用户调用模型评估，只有判为相关者加入候选。关注时优先使用 CSV 中的用户数字 ID（`authorId`/`userId` 等），缺失的才批量解析用户名，然后串行调用 X API 关注；未能解析的用户保留在未处理列表。**该命令会实际发送关注请求。** 帖子读取和回复导出仍通过浏览器，关注不再操作原帖菜单。如果 CSV 没有用户数字 ID，解析得到的是查询时用户名对应的账号。

补充到的关注/粉丝数会写回原 CSV 同目录的 `*-enriched.csv`，新增 `followersCount`、`followingCount` 两列；筛选和关注使用同一份内存数据。

模型配置为 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`，仅在使用 `--evaluate` 时需要。结果和任务状态保存在 `.data/loop-runs`、`.data/loop.sqlite`，API 关注记录在 `.data/following.sqlite`。任务可从断点恢复：

```sh
npm run test-loop -- --resume <任务ID>
npm run loop:health
```

旧的浏览器关注任务不会自动迁移为 API 任务，需要先核对其已关注和结果不明的用户。

## 镜像发帖（准实时 hook）

把某个目标用户的**新发帖**复制文本与图片、用另一个授权账号发新帖（视频/GIF 跳过）。X 不提供面向任意第三方的“发帖即回调”webhook，这里启动时先回填目标最新 3 条，随后优先用 **filtered stream**（一条长连接、X 实时推送，需 API 套餐支持 filtered stream）；连不上或套餐不支持时自动回退到 REST 轮询（间隔默认 60 秒，可用 `MIRROR_INTERVAL_MS` 调整，`--poll` 强制轮询，`--once` 只跑一次）。状态持久化在 `.data/mirror.sqlite`，重启后从水位线继续，不会重复发同一帖。

```sh
# 目标用户发新帖后，复制文本用发帖账号发新帖（发帖账号须具备 tweet.write）
npm run mirror -- <目标用户名> <发帖账号数字ID>
npm run mirror -- list
npm run mirror -- remove <目标用户名>
```

发帖账号需先完成 X 授权并授予 `tweet.write` 与 `media.write`。程序按目标用户名解析数字 ID，**启动时先回填目标最新 3 条帖子**，随后优先用 filtered stream 实时监听新帖、失败回退 REST 轮询（`since_id` 只取新帖、排除转发）。每条帖子复制文本（截断到 280 字符）与图片（最多 4 张，jpg/png/webp，≤5 MB），**视频和 GIF 跳过**；失败的帖子最多重试 3 次后跳过，收到 429 冷却 15 分钟。**复制原文内容有被 X 判为垃圾/冒充的风险**，请自行评估并控制频率。

## 失败与冷却

收到 X 429 后，帖子读取、用户数据读取或 API 关注阶段冷却 15 分钟，再进入半开：只读阶段使用只读探测；关注最多发起一次新的关注请求，确认成功才继续。明确受限则再次冷却；请求结果不明会记录 `uncertain` 并停止，避免重复提交。插件导出中断也需先核实。进程退出后需用相同任务 ID 恢复；本地队列不是外部消息队列。

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
- `scripts/clone_user/`：独立的账号资料复制，使用 `npm run clone_user -- <目标用户名> <子账号资料名>`；已 clone 的账号会跳过复制。clone 完成后，loop 默认使用该来源博主采集帖子回复。
- `scripts/mirror/`：目标发帖镜像（准实时 hook）。使用 `npm run mirror -- <目标用户名> <发帖账号数字ID>` 注册并持续轮询目标新帖，复制文本用发帖账号发新帖；`npm run mirror -- list` 查看，`npm run mirror -- remove <目标用户名>` 移除。
- `scripts/follow/`：关注操作。
- `scripts/loop/`：单轮任务、队列和恢复。
- `scripts/replies/`：回复导出和筛选。
