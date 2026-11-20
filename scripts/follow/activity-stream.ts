import '../../src/runtime-config.ts';
/** X Activity 关注事件的连接、订阅、读取与流锁（follow-stream 与 follow-reply 共用）。 */
import { setTimeout as delay } from 'node:timers/promises';
import { AccountStore } from '../../src/account-store.ts';
import { open, readFile, unlink } from 'node:fs/promises';
import { fetchXWithCircuit } from '../../src/x-api-circuit.ts';

const BASE = 'https://api.x.com/2/activity';

export type ActivityHttp = (path: string, init?: RequestInit) => Promise<Response>;

export type FollowEvent = {
  eventId: string;
  occurredAt?: string;
  followerId: string;
  followerUsername: string;
  accountId: string;
};

export type DmEvent = { eventId: string; messageId: string; accountId: string; senderId: string; text: string; occurredAt?: string };
export type ChatEvent = { eventId: string; messageId: string; accountId: string; senderId: string; conversationId: string; encodedEvent?: string; conversationKeyChangeEvent?: string };

/** 提取 XChat 事件的元数据和解密所需的密文，不记录密文。 */
export function parseChatEvent(event: any): ChatEvent | null {
  const accountId = event?.filter?.user_id;
  const payload = event?.payload;
  if (event?.event_type !== 'chat.received' || typeof event.event_uuid !== 'string' || !event.event_uuid || typeof accountId !== 'string' || !/^\d{1,19}$/.test(accountId) || typeof payload?.sender_id !== 'string' || !/^\d{1,19}$/.test(payload.sender_id) || payload.sender_id === accountId || typeof payload.id !== 'string' || !payload.id || typeof payload.conversation_id !== 'string' || !payload.conversation_id) return null;
  return { eventId: event.event_uuid, messageId: payload.id, accountId, senderId: payload.sender_id, conversationId: payload.conversation_id,
    ...(typeof payload.encoded_event === 'string' && payload.encoded_event ? { encodedEvent: payload.encoded_event } : {}),
    ...(typeof payload.conversation_key_change_event === 'string' && payload.conversation_key_change_event ? { conversationKeyChangeEvent: payload.conversation_key_change_event } : {}) };
}

/** 解析旧版入站 DM，校验接收账号，忽略自己发送及不含文本的事件。 */
export function parseDmEvents(event: any): DmEvent[] {
  if (event?.event_type !== 'dm.received' || typeof event.event_uuid !== 'string' || !Array.isArray(event.payload?.direct_message_events)) return [];
  const accountId = event.filter?.user_id;
  if (typeof accountId !== 'string' || !/^\d{1,19}$/.test(accountId)) return [];
  return event.payload.direct_message_events.flatMap((item: any) => {
    const message = item?.message_create;
    const senderId = message?.sender_id;
    if (item?.type !== 'message_create' || typeof item.id !== 'string' || !/^\d{1,19}$/.test(item.id) || typeof senderId !== 'string' || !/^\d{1,19}$/.test(senderId) || senderId === accountId || message?.target?.recipient_id !== accountId || typeof message?.message_data?.text !== 'string' || !message.message_data.text.trim()) return [];
    return [{ eventId: event.event_uuid, messageId: item.id, accountId, senderId, text: message.message_data.text, occurredAt: event.created_at }];
  });
}

/** 复用或创建入站私信订阅；可用的认证方式以 X 实际响应为准。 */
export async function ensureMessageSubscription(api: ActivityHttp, accountId: string, eventType: 'dm.received' | 'chat.received', createApi: ActivityHttp = api): Promise<string> {
  const response = await api(`/subscriptions?${new URLSearchParams({ user_id: accountId })}`);
  const result: any = await response.json();
  if (!Array.isArray(result.data) && result.data !== undefined) throw new Error('私信订阅列表格式无效');
  if ((result.data || []).some((item: any) => item.event_type === eventType && item.filter?.user_id === accountId && !item.filter?.qualifiers?.conversation_type)) return `已有 ${eventType} 订阅。`;
  const created = await createApi('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: eventType, filter: { user_id: accountId }, tag: eventType === 'chat.received' ? 'chat-inbound' : 'dm-inbound' }) });
  await created.json();
  return `${eventType} 订阅已创建。`;
}

export async function ensureDmSubscription(api: ActivityHttp, accountId: string, createApi: ActivityHttp = api): Promise<string> {
  return ensureMessageSubscription(api, accountId, 'dm.received', createApi);
}

/** 构造 Activity API 请求函数；app 令牌或经本地授权服务获取用户令牌。 */
export function makeActivityApi(opts: {
  accountId: string;
  useAppToken: boolean;
  appToken?: string;
  port?: number | string;
  controller: AbortController;
}): ActivityHttp {
  const { accountId, useAppToken, appToken, controller } = opts;
  const port = Number(opts.port || process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  if (useAppToken && !appToken) throw new Error('请在 .env 配置 X_ACTIVITY_APP_BEARER_TOKEN');
  return async (path, init = {}) => {
    let token: string;
    if (useAppToken) {
      token = appToken!;
    } else {
      const local = await fetch(`http://127.0.0.1:${port}/api/accounts/${accountId}/me`, { headers: { 'X-Local-Request': '1' }, signal: controller.signal });
      if (!local.ok) throw new Error(`本地授权服务检查失败（HTTP ${local.status}），请检查账号授权及 X 网络连接`);
      const store = new AccountStore('.data');
      try {
        const account = store.getByUuid(accountId);
        if (!account?.authenticated || !account.accessToken) throw new Error('数据库中没有该账号的有效授权');
        token = account.accessToken;
      } finally { store.close(); }
    }
    const response = await fetchXWithCircuit(BASE + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000).replaceAll(token, '[已隐藏]');
      throw new Error(`X API HTTP ${response.status}: ${init.method || 'GET'} ${path.split('?')[0]}: ${detail}`);
    }
    return response;
  };
}

/** 复用或创建指定账号的入站关注订阅。 */
export async function ensureFollowSubscription(api: ActivityHttp, accountId: string): Promise<string> {
  const response = await api(`/subscriptions?${new URLSearchParams({ user_id: accountId })}`);
  const result: any = await response.json();
  const list = Array.isArray(result.data) ? result.data : [];
  const found = list.some((item: any) => item.event_type === 'follow.follow' && item.filter?.user_id === accountId && (item.filter?.qualifiers?.direction === 'inbound' || item.filter?.direction === 'inbound'));
  if (!found) {
    const created = await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'follow.follow', filter: { user_id: accountId, qualifiers: { direction: 'inbound' } }, tag: 'follow-stream' }) });
    return `关注事件订阅已创建：${JSON.stringify(await created.json())}`;
  }
  return '已有关注事件订阅。';
}

/** 持续读取 Activity 流；每条有效入站关注事件回调一次，不补漏、不保存。 */
export async function receiveFollowEvents(api: ActivityHttp, controller: AbortController, onFollow: (event: FollowEvent) => void, onState: (state: string) => void = () => {}, onDm: (event: DmEvent) => void = () => {}, onChat: (event: ChatEvent) => void = () => {}): Promise<void> {
  let retry = 1;
  while (!controller.signal.aborted) {
    try {
      onState('连接关注事件流');
      const response = await api('/stream');
      if (!response.body) throw new Error('X 未返回流数据');
      onState('监听关注与回关事件');
      console.log('Activity 流已连接。');
      retry = 1;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          if (buffer.length > 1024 * 1024) throw new Error('流数据超过 1 MB，停止本次连接');
          const lines = buffer.split('\n'); buffer = lines.pop()!;
          for (const line of lines) {
            const text = line.trim(); if (!text) continue;
            let item: any;
            try { item = JSON.parse(text); } catch { console.error('收到无法解析的流数据，跳过'); continue; }
            if (item.errors?.length) console.error('流返回错误：', JSON.stringify(item.errors));
            const event = item.data;
            if (event?.event_type === 'chat.received') {
              const chat = parseChatEvent(event);
              if (chat) onChat(chat);
              continue;
            }
            if (event?.event_type === 'dm.received') {
              for (const dm of parseDmEvents(event)) onDm(dm);
              continue;
            }
            if (event?.event_type !== 'follow.follow') continue;
            const source = event.payload?.source?.data, target = event.payload?.target?.data;
            if (typeof source?.id !== 'string' || !/^\d{1,19}$/.test(source.id) || typeof target?.id !== 'string' || !/^\d{1,19}$/.test(target.id) || typeof event.event_uuid !== 'string') continue;
            onFollow({
              eventId: event.event_uuid,
              occurredAt: event.created_at,
              followerId: source.id,
              followerUsername: typeof source.username === 'string' ? source.username : '',
              accountId: target.id,
            });
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!controller.signal.aborted) console.error('连接结束，准备重连；断线期间可能漏事件。');
    } catch (error) {
      if (controller.signal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      if (/X API HTTP (400|401|403|404):/.test(message)) throw error;
      console.error(`连接失败：${message}`);
      if (/X API HTTP 429/.test(message)) {
        onState('X API 限流，等待熔断冷却');
        try { await delay(15 * 60_000, undefined, { signal: controller.signal }); } catch { break; }
        continue;
      }
    }
    onState('连接断开，等待重连');
    try { await delay(retry * 1000, undefined, { signal: controller.signal }); } catch { break; }
    retry = Math.min(retry * 2, 60);
  }
}

/** 独占 Activity 流锁，执行 fn 后释放；防止多个 loop 抢占同一应用流。 */
export async function withActivityStreamLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = '.data/activity-stream.lock';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const pid = (await readFile(lock, 'utf8')).trim();
      if (!/^\d+$/.test(pid)) throw new Error('Activity 流锁无效，请检查');
      try { process.kill(Number(pid), 0); throw new Error('Activity 流已由另一个进程运行；多账号暂不支持并行监听'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await unlink(lock);
    }
  }
  try { return await fn(); } finally { await unlink(lock).catch(() => {}); }
}
