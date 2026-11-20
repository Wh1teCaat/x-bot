import '../../src/runtime-config.ts';
import { ensureMessageSubscription, makeActivityApi, receiveFollowEvents, withActivityStreamLock } from './activity-stream.ts';

const accountId = process.argv[2];
if (!/^\d{1,19}$/.test(accountId || '')) throw new Error('用法：npm run dm:stream-test -- <授权账号数字ID>');
const appToken = process.env.X_ACTIVITY_APP_BEARER_TOKEN;
if (!appToken) throw new Error('请配置 X_ACTIVITY_APP_BEARER_TOKEN');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const api = makeActivityApi({ accountId, useAppToken: true, appToken, controller });
const userApi = makeActivityApi({ accountId, useAppToken: false, controller });

await withActivityStreamLock(async () => {
  console.log('正在使用应用令牌检查 DM 和 XChat 订阅；如需创建，使用账号用户令牌。');
  for (const eventType of ['dm.received', 'chat.received'] as const) {
    console.log(await ensureMessageSubscription(api, accountId, eventType, userApi));
  }
  console.log('私信流测试已启动；仅显示事件元数据，不解密、不调用 LLM、不发送消息。Ctrl+C 停止；订阅不会自动删除。');
  const seen = new Set<string>();
  await receiveFollowEvents(api, controller, () => {}, () => {}, (event) => {
    const key = `dm:${event.messageId}`;
    if (event.accountId !== accountId || seen.has(key)) return;
    seen.add(key);
    if (seen.size > 10000) seen.delete(seen.values().next().value!);
    console.log(`收到 DM 事件：账号 ${event.accountId}，发送者 ${event.senderId}，消息 ID ${event.messageId}，文本长度 ${event.text.length}`);
  }, (event) => {
    const key = `chat:${event.messageId}`;
    if (event.accountId !== accountId || seen.has(key)) return;
    seen.add(key);
    if (seen.size > 10000) seen.delete(seen.values().next().value!);
    console.log(`收到 XChat 事件：账号 ${event.accountId}，发送者 ${event.senderId}，消息 ID ${event.messageId}，会话 ID ${event.conversationId}`);
  });
}).catch(error => { if (!controller.signal.aborted) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } });
