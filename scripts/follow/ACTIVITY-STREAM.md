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

正常 `npm run loop -- <账号ID>` 在配置应用令牌后启动 `run` 子进程：复用或创建关注、DM 和 XChat 订阅，并使用一条 Activity 流。收到单向关注时加入关注 Outbox，按已有批次和限额执行回关；只有关注状态确认 `following` 后才发送欢迎，待批准或结果不明确时不发。每个账号和对方最多预留一次欢迎。没有 PIN 的账号使用一次性欢迎及 WhatsApp 引导，有 PIN 的账号先欢迎，再处理入站消息。多账号暂不能并行监听同一应用流，后启动的监听器会退出；停止 loop 不删除 X 端订阅。

## 独立命令：回关监听 + 私信回复

沟通规则保存在 `scripts/follow/dm-skill.md`，按欢迎、一次性欢迎和对方回复三个阶段调用。账号设置页可导入四位 XChat PIN，加密后存于对应账号；PIN 更新后重置解锁失败标记。配置 PIN 的账号在收到私信后使用队列处理，Chat 消息先解密验证，再将最近对话发给 LLM，回复仍使用 DM 发送接口。消息和欢迎去重状态保存在 `.data/customer-service.sqlite`。处理失败不会自动重发；发送结果不明确时标为 uncertain，需人工核查。流断线期间不补漏，未处理的持久化消息也不会自动恢复。PIN 解锁失败后暂停该账号的自动解锁，检查后重新导入；首次失败不要反复尝试。现有 XChat 会话上的 DM 回复是否成功需要真实验证。

### 入站 DM 和 XChat 流测试

先停止占用 Activity 流锁的 loop / follow-reply，配置 `X_ACTIVITY_APP_BEARER_TOKEN`，启动本地授权服务 `npm start`，并为账号授权 `dm.read`。在项目目录执行 `npm run dm:stream-test -- <账号数字ID>`。命令用应用令牌查询 `dm.received` 和 `chat.received` 订阅并连接同一条流；缺少订阅时使用账号 OAuth 用户令牌创建。收到事件时仅输出事件类型及元数据，不解密、不发回复。Ctrl+C 停止，已创建的 X 端订阅保留。重复消息只在本次进程内去重，断线期间不补漏。

要测试读取 XChat 正文，使用 `npm run dm:stream-test -- <账号数字ID> --decrypt`，在机器本地交互终端输入该账号已有的 XChat PIN（不回显、不保存）。程序从账号的现有安全备份恢复密钥，获取参与者签名公钥并验证消息，成功后会在终端显示正文；不要录屏或公开日志。首次读取会查询会话历史以获取密钥变更，不发送消息、不生成新密钥。实际账号的备份、历史和签名密钥能否访问仍需实测；首次 PIN 失败请勿反复尝试，以免耗尽备份允许的尝试次数。

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

