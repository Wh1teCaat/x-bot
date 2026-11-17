/** 独立的 X Activity 关注事件测试，不接入项目业务流程。 */
import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { AccountStore } from '../../src/account-store.ts';
import { FollowStore } from '../../src/follow-store.ts';
import { open, readFile, unlink } from 'node:fs/promises';

const command = process.argv[2] || 'stream';
const accountId = process.argv[3] || process.env.X_ACTIVITY_ACCOUNT_ID;
const appToken = process.env.X_ACTIVITY_APP_BEARER_TOKEN;
const useAppToken = process.argv.includes('--app');
const base = 'https://api.x.com/2/activity';
if (!['subscribe', 'stream', 'list', 'run'].includes(command) || !accountId || !/^\d{1,19}$/.test(accountId)) throw new Error('用法：node scripts/follow/follow-stream.ts <list|subscribe|stream|run> <授权账号数字ID>');
if (command === 'run' && !useAppToken) throw new Error('run 需要 --app 以连接事件流');
if (useAppToken && !appToken) throw new Error('请在 .env 配置 X_ACTIVITY_APP_BEARER_TOKEN');
if (!useAppToken && (!existsSync('.data/accounts.sqlite') || !existsSync('.data/key'))) throw new Error('找不到账号数据库或加密密钥，请在项目目录运行并先完成授权');

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

async function api(path: string, init: RequestInit = {}, applicationToken = useAppToken) {
  let token: string;
  if (applicationToken) {
    token = appToken!;
  } else {
  // 刷新交由已运行的本地授权服务串行处理，避免多个进程同时使用 refresh token。
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const local = await fetch(`http://127.0.0.1:${port}/api/accounts/${accountId}/me`, { headers: { 'X-Local-Request': '1' }, signal: controller.signal });
  if (!local.ok) throw new Error(`本地授权服务检查失败（HTTP ${local.status}），请检查账号授权及 X 网络连接`);
  const store = new AccountStore('.data');
  try {
    const account = store.getByUuid(accountId!);
    if (!account?.authenticated || !account.accessToken) throw new Error('数据库中没有该账号的有效授权');
    token = account.accessToken;
  } finally { store.close(); }
  }
  const response = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: controller.signal });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000).replaceAll(token, '[已隐藏]');
    throw new Error(`X API HTTP ${response.status}: ${detail}`);
  }
  return response;
}

async function main() {
  if (command === 'run') {
    // 一个应用共用一条事件流。锁阻止多个 loop 抢占同一个连接。
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
    try {
      const response = await api(`/subscriptions?${new URLSearchParams({ user_id: accountId! })}`);
      const result: any = await response.json();
      const list = Array.isArray(result.data) ? result.data : [];
      const found = list.some(item => item.event_type === 'follow.follow' && item.filter?.user_id === accountId && (item.filter?.qualifiers?.direction === 'inbound' || item.filter?.direction === 'inbound'));
      if (!found) {
        // Existing subscriptions with a different filter may overlap; let X reject them explicitly.
        const created = await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'follow.follow', filter: { user_id: accountId, qualifiers: { direction: 'inbound' } }, tag: 'follow-stream' }) }, false);
        console.log('关注事件订阅已创建：', JSON.stringify(await created.json()));
      } else console.log('已有关注事件订阅。');
      await receive();
    } finally { await unlink(lock).catch(() => {}); }
    return;
  }
  if (command === 'subscribe') {
    if (!accountId || !/^\d{1,19}$/.test(accountId)) throw new Error('请提供要监听的账号数字 ID');
    const response = await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'follow.follow', filter: { user_id: accountId, qualifiers: { direction: 'inbound' } }, tag: 'follow-stream-test' }) });
    console.log('订阅创建结果：', JSON.stringify(await response.json()));
    return;
  }
  if (command === 'list') {
    const response = await api(`/subscriptions?${new URLSearchParams({ user_id: accountId! })}`);
    console.log('订阅列表：', JSON.stringify(await response.json()));
    return;
  }
  await receive();
}

async function receive() {
  let retry = 1;
  const seen = new Set<string>();
  while (!controller.signal.aborted) {
    try {
      const response = await api('/stream');
      if (!response.body) throw new Error('X 未返回流数据');
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
            if (command !== 'run' && event.event_uuid && seen.has(event.event_uuid)) continue;
            if (command !== 'run' && event.event_uuid) { seen.add(event.event_uuid); if (seen.size > 10000) seen.delete(seen.values().next().value!); }
            const source = event.payload?.source?.data, target = event.payload?.target?.data;
            console.log(JSON.stringify({ eventId: event.event_uuid, time: event.created_at, followerId: source?.id, follower: source?.username, accountId: target?.id }));
            if (command === 'run' && typeof source?.id === 'string' && /^\d{1,19}$/.test(source.id) && typeof target?.id === 'string' && /^\d{1,19}$/.test(target.id) && typeof event.event_uuid === 'string') {
              const store = new FollowStore('.data/following.sqlite');
              try { const outcome = store.recordInboundFollow(event.event_uuid, target.id, source.id, event.created_at); console.log(`关注事件已保存：${outcome}`); }
              finally { store.close(); }
            }
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
    try { await delay(retry * 1000, undefined, { signal: controller.signal }); } catch { break; }
    retry = Math.min(retry * 2, 60);
  }
}

main().catch(error => { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } });
