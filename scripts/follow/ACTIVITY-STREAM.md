# 关注事件流独立测试

无需 webhook、公网地址或 Cloudflare Tunnel；不会接入现有关注或聊天流程。先在项目目录运行 `npm start`，并完成账号 OAuth 授权。脚本从 `.data/accounts.sqlite` 和密钥读取指定账号的 Access Token；调用本地授权服务检查并在必要时刷新令牌，不需要复制令牌。X 是否接受用户令牌访问 Activity 接口以实际响应为准。

先查看已有订阅，避免重复创建或影响其他应用：

```bash
node scripts/follow/follow-stream.ts list 账号数字ID
```

对照测试应用令牌时，在 `.env` 配置 `X_ACTIVITY_APP_BEARER_TOKEN`，然后运行 `node scripts/follow/follow-stream.ts list 账号数字ID --app`。不要将令牌提交或分享。用户令牌和应用令牌的访问权限可能不同。

创建指定账号的入站关注订阅（此操作会修改 X 应用订阅，事件可能计费）：

```bash
node scripts/follow/follow-stream.ts subscribe 账号数字ID
```

启动监听：

```bash
node scripts/follow/follow-stream.ts stream 账号数字ID
```

用另一个账号关注该账号，观察终端输出；按 Ctrl+C 停止。需要能从本机访问 X API：系统 VPN 可直接使用，环境变量代理是否生效取决于 Node 版本和配置，不能假定 Node 默认读取代理变量。订阅不随进程结束自动删除，按需在 X 管理订阅。脚本断线后重连、仅在内存中去重，不补漏、不保存事件，也不判断是否互关。收到事件只能证明事件流接收成功。关于流的具体计费，请在 X 开发者控制台核对。

正常 `npm run loop -- <账号ID>` 在配置应用令牌后启动 `run` 子进程：复用或创建入站关注订阅，将事件按 ID 去重保存到 `.data/following.sqlite` 的 `inbound_follows`，并与本地出站关注状态对照。保存新事件后，若已配置 `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL`，会用 LLM 生成一条欢迎私信（首句固定为英文 `hello`）并通过本地授权服务发送给对方（需要账号重新授权并授予 `dm.read`/`dm.write`，且 X 应用需具备 Direct Message 访问）；私信串行发送，失败只记录日志、不阻塞事件流，也不会补发。监听不补漏、不处理取消关注；历史事件与当前关注状态仅说明曾观察到互关，不能证明目前仍然互关。子进程退出时主流程会报告，不自动重启。多个 loop 暂不能同时使用该应用流；已有监听器时后启动的子进程会退出并提示。停止 loop 不会删除 X 端订阅。

## 独立命令：回关监听 + 私信回复

欢迎私信的沟通规则保存在 `scripts/follow/dm-skill.md`，生成时加载。目前自动回复只支持回关后的第一条欢迎私信；入站私信仅有独立的流测试入口，尚未接入客服队列或保存对话上下文，因此 skill 中对方回复后的规则尚不会自动触发。

### 入站 DM 和 XChat 流测试

先停止占用 Activity 流锁的 loop / follow-reply，配置 `X_ACTIVITY_APP_BEARER_TOKEN`，启动本地授权服务 `npm start`，并为账号授权 `dm.read`。在项目目录执行 `npm run dm:stream-test -- <账号数字ID>`。命令用应用令牌查询 `dm.received` 和 `chat.received` 订阅并连接同一条流；缺少订阅时使用账号 OAuth 用户令牌创建。收到事件时仅输出事件类型及元数据，不解密、不发回复。Ctrl+C 停止，已创建的 X 端订阅保留。重复消息只在本次进程内去重，断线期间不补漏。

若 X 返回 403，日志会标明失败的请求方法和路径。`GET /subscriptions` 是查询订阅，`POST /subscriptions` 是创建订阅，`GET /stream` 是连接流；检查账号 OAuth scope、X 应用权限和套餐后再排查对应步骤。账号页面显示已授权关注不代表已经授权 `dm.read`。

不启动完整 loop 也可以单独跑「监听回关 → 落库 → LLM 生成 → 发私信」：

```bash
# 终端 1：本地授权服务（私信发送与用户令牌刷新依赖它）
npm start

# 终端 2：独立监听（--app 用应用流；不加 --app 则经本机服务用用户令牌）
npm run follow-reply -- <账号数字ID> --app
```

先跑一遍本地自测（不访问 X、不调真实 LLM、不写真实数据库）：

```bash
npm run follow-reply -- <账号数字ID> --mock
```

该命令会串行处理事件、失败只记录不阻塞，行为与 loop 内的 `run` 子进程一致。真实发送仍需：账号重新授权拿到 `dm.read`/`dm.write`、应用具备 Direct Message 访问、并配置 `LLM_API_KEY`/`LLM_MODEL`/`LLM_BASE_URL`。

