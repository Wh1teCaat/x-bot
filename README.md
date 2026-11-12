# X 回复筛选与 API 关注

流程使用正式版 Google Chrome 与 CommentCrate 搜索帖子、导出回复；按阿拉伯文字初筛后，将其余回复交给模型评估；最后通过 X 官方 API 关注候选用户。阿拉伯文字和回复内容不能证明用户所在地或国籍。

## 授权

1. 配置 `.env`：参考 `.env.example` 填写 X 开发者应用的客户端 ID、客户端密钥（public client 可省略）和模型配置。开发者控制台的 OAuth 回调必须与 `X_REDIRECT_URI` 一致，默认为 `http://127.0.0.1:3000/oauth/callback`。应用需要读取用户和关注关系及关注写入权限。
2. 执行 `npm start`，打开 [本机授权页面](http://127.0.0.1:3000/)，点击「前往 X 授权」，由账号所有者在 X 完成登录和授权。授权页面仅用于授权与查看已授权账号。
3. 授权成功后，程序默认通过系统命令启动该账号的独立正式版 Google Chrome 窗口；登录之前不会使用 Playwright 连接。首次使用时，在新窗口手动登录**相同的 X 账号**、安装 CommentCrate 并授予 X 访问权限，然后执行 `npm run account:ready -- <账号数字ID>`。程序连接并核对账号和插件后执行一轮。OAuth 令牌不会自动登录浏览器。浏览器资料保存在 `.data/browser-profiles/<账号数字ID>`，各账号的资料和调试端口独立，不会复制日常浏览器资料。
4. 在 `.env` 设置 `X_AUTO_START_LOOP=false` 可关闭授权后的实例启动。启动信息和等待原因写入 `.data/account-sessions/<账号数字ID>.log`；浏览器登录失败时可在窗口中人工处理。请在每个账号的独立浏览器资料中手动安装 CommentCrate。普通配置文件不能替用户授予 CommentCrate 的可选 X 站点权限，首次需在该资料目录中人工允许；之后可复用该目录中的授权。

同一账号优先复用已打开且空闲的实例：再次授权或执行 `npm run account -- run <账号数字ID>` 可以启动下一轮。`npm run account -- status <账号数字ID>` 查看状态及错误；`npm run account -- stop <账号数字ID>` 关闭该账号的实例，保留其资料目录。实例只复用给绑定的账号，不在账号间共享登录状态。

授权申请 `tweet.read`、`users.read`、`follows.read`、`follows.write` 和 `offline.access`。已有账号如缺少权限需重新授权。令牌加密保存在 `.data/accounts.enc`，密钥在 `.data/key`；二者位于同一机器，保护范围限于避免意外查看。服务只监听本机，不要将其公开到网络。用户查询和关注会消耗 API 额度，具体权限、费用及限额以 X 开发者控制台为准。

## 单轮流程

手动模式可启动 `npm run browser`，在正式版 Google Chrome 的独立资料目录（`.data/manual-chrome-profile`）中登录 X 并安装、启用 CommentCrate；另开终端启动 `npm start`，再运行：

```sh
npm run test-loop
```

也可使用 `npm run test-loop -- --account-id <数字ID> --username <用户名> --cdp-port <端口>` 指定账号及浏览器，账号一旦绑定到任务，恢复时不能换账号。单个已授权账号无需指定 ID；有多个时可在 `.env` 中设置 `X_FOLLOW_ACCOUNT_ID`。配置通过 `dotenv` 加载，任务 ID、账号和端口等运行状态通过参数传递。

独立窗口为多账号隔离提供基础，但当前帖子与用户去重和 X 熔断仍为全局状态，因此同一时间只执行一轮；尚不支持多账号并行。不同账号可同时准备各自的浏览器资料。

单轮生成关键词，从前 10 条搜索结果中选择回复最多且未处理的帖子，导出回复。规则直接选入含至少两个阿拉伯字母的用户，其余回复分批交给模型；只有模型判为相关者加入候选。程序批量将用户名解析为数字 ID，然后串行调用 X API 关注；未能解析的用户保留在未处理列表。**该命令会实际发送关注请求。** 搜索和回复导出仍通过浏览器，关注不再操作原帖菜单。由于导出没有用户数字 ID，解析得到的是查询时用户名对应的账号。

模型配置为 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`。结果和任务状态保存在 `.data/loop-runs`、`.data/loop.sqlite`，API 关注记录在 `.data/following.sqlite`。任务可从断点恢复：

```sh
npm run test-loop -- --resume <任务ID>
npm run loop:health
```

旧的浏览器关注任务不会自动迁移为 API 任务，需要先核对其已关注和结果不明的用户。

## 失败与冷却

收到 X 429 后，搜索或 API 关注阶段冷却 15 分钟，再进入半开：搜索使用只读搜索；关注最多发起一次新的关注请求，确认成功才继续。明确受限则再次冷却；请求结果不明会记录 `uncertain` 并停止，避免重复提交。插件导出中断也需先核实。进程退出后需用相同任务 ID 恢复；本地队列不是外部消息队列。

人工核实 API 关注的实际状态后，可记录结果（不发送请求）：

```sh
npm run loop:health -- resolve-api-follow <授权账号数字ID> <目标账号数字ID> following
# 其他结果：pending、not_following
```

旧浏览器关注记录仍可用 `resolve-follow <当前用户名> <目标用户名> following|pending|not_following` 核实。若确需人工重置熔断，可执行 `npm run loop:health -- reset x` 或 `-- reset llm`；重置本身不会启动任务。

## 备用与测试

脚本和测试均使用 TypeScript，Node.js 22.18 及以上版本可直接运行。`npm run typecheck` 检查源码、脚本和测试；当前配置尚未开启 TypeScript 严格模式。`npm test` 使用本地模拟接口，不访问真实 X API；浏览器测试可用 `XBOT_BROWSER_TEST=1 npm test` 启用。
