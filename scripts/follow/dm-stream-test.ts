import '../../src/runtime-config.ts';
import { ensureMessageSubscription, makeActivityApi, receiveFollowEvents, withActivityStreamLock } from './activity-stream.ts';
import { createXChatReader } from './xchat-decrypt.ts';

const accountId = process.argv[2];
if (!/^\d{1,19}$/.test(accountId || '')) throw new Error('用法：npm run dm:stream-test -- <授权账号数字ID>');
const appToken = process.env.X_ACTIVITY_APP_BEARER_TOKEN;
if (!appToken) throw new Error('请配置 X_ACTIVITY_APP_BEARER_TOKEN');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const api = makeActivityApi({ accountId, useAppToken: true, appToken, controller });
const userApi = makeActivityApi({ accountId, useAppToken: false, controller });
const decrypt = process.argv.includes('--decrypt');

/** PIN 只从本机交互终端读取，不回显或写入磁盘。 */
async function readPin(): Promise<Uint8Array> {
  if (!process.stdin.isTTY) throw new Error('解密测试需要交互式终端输入 XChat PIN');
  process.stderr.write('请输入此账号的 XChat PIN（不回显）：');
  const input = process.stdin;
  input.setRawMode(true); input.resume();
  const bytes: number[] = [];
  try {
    for await (const chunk of input) {
      for (const byte of chunk as Buffer) {
        if (byte === 3) throw new Error('已取消输入');
        if (byte === 13 || byte === 10) return Uint8Array.from(bytes);
        if (byte === 127 || byte === 8) bytes.pop(); else if (byte >= 32 && bytes.length < 128) bytes.push(byte);
      }
    }
    throw new Error('PIN 输入已结束');
  } finally { bytes.fill(0); input.setRawMode(false); input.pause(); process.stderr.write('\n'); }
}

await withActivityStreamLock(async () => {
  let reader: Awaited<ReturnType<typeof createXChatReader>> | null = null;
  if (decrypt) {
    const pin = await readPin();
    try { reader = await createXChatReader(accountId, pin); } finally { pin.fill(0); }
  }
  let pending = Promise.resolve();
  try {
  console.log('正在使用应用令牌检查 DM 和 XChat 订阅；如需创建，使用账号用户令牌。');
  for (const eventType of ['dm.received', 'chat.received'] as const) {
    console.log(await ensureMessageSubscription(api, accountId, eventType, userApi));
  }
  console.log(`私信流测试已启动；${reader ? '将显示验证通过的 XChat 文本' : '仅显示事件元数据'}，不调用 LLM、不发送消息。Ctrl+C 停止；订阅不会自动删除。`);
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
    if (reader) pending = pending.then(async () => {
      const text = await reader.decrypt(event);
      if (text !== null) console.log(`XChat 消息正文：${text}`);
      else console.log('收到非文本 XChat 事件。');
    }).catch(() => { console.error('XChat 解密失败：请检查账号密钥、会话密钥和参与者签名公钥。'); });
  });
  await pending;
  } finally { reader?.close(); }
}).catch(error => { if (!controller.signal.aborted) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } });
