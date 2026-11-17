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

正常 `npm run loop -- <账号ID>` 在配置应用令牌后启动 `run` 子进程：复用或创建入站关注订阅，将事件按 ID 去重保存到 `.data/following.sqlite` 的 `inbound_follows`，并与本地出站关注状态对照。监听不补漏、不处理取消关注；历史事件与当前关注状态仅说明曾观察到互关，不能证明目前仍然互关。子进程退出时主流程会报告，不自动重启。多个 loop 暂不能同时使用该应用流；已有监听器时后启动的子进程会退出并提示。停止 loop 不会删除 X 端订阅。
