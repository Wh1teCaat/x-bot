import '../../src/runtime-config.ts';
/** X Activity 关注事件的连接、订阅、读取与流锁（follow-stream 与 follow-reply 共用）。 */
import { setTimeout as delay } from 'node:timers/promises';
import { AccountStore } from '../../src/account-store.ts';
import { open, readFile, unlink } from 'node:fs/promises';

const BASE = 'https://api.x.com/2/activity';

export type ActivityHttp = (path: string, init?: RequestInit) => Promise<Response>;

export type FollowEvent = {
  eventId: string;
  occurredAt?: string;
  followerId: string;
  followerUsername: string;
  accountId: string;
};

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
    const response = await fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000).replaceAll(token, '[已隐藏]');
      throw new Error(`X API HTTP ${response.status}: ${detail}`);
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
export async function receiveFollowEvents(api: ActivityHttp, controller: AbortController, onFollow: (event: FollowEvent) => void, onState: (state: string) => void = () => {}): Promise<void> {
  let retry = 1;
  while (!controller.signal.aborted) {
    try {
      onState('连接关注事件流');
      const response = await api('/stream');
      if (!response.body) throw new Error('X 未返回流数据');
      onState('监听关注与回关事件');
      console.log('Activity 流已连接；收到关注事件时会打印。');
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
      console.error('连接结束，准备重连；断线期间可能漏事件。');
    } catch (error) {
      if (controller.signal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      if (/X API HTTP (400|401|403|404):/.test(message)) throw error;
      console.error(`连接失败：${message}`);
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
