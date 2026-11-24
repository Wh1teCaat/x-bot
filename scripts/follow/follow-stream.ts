import '../../src/runtime-config.ts';
/** 独立的 X Activity 关注事件测试；run 子命令接入回关落库与私信回复。 */

import { monitorProcess, recordRuntimeEvent } from '../../src/runtime-monitor.ts';
import { existsSync } from 'node:fs';
import { queueInboundFollow, completedInboundFollows } from './inbound-follow.ts';
import { makeLlm } from '../loop/loop-llm.ts';
import { LocalDmClient } from './dm-reply.ts';
import { makeActivityApi, ensureFollowSubscription, ensureMessageSubscription, receiveFollowEvents, withActivityStreamLock } from './activity-stream.ts';
import { createCustomerService } from './customer-service.ts';

const command = process.argv[2] || 'stream';
const accountId = process.argv[3] || process.env.X_ACTIVITY_ACCOUNT_ID;
const appToken = process.env.X_ACTIVITY_APP_BEARER_TOKEN;
const useAppToken = process.argv.includes('--app');
if (!['subscribe', 'stream', 'list', 'run'].includes(command) || !accountId || !/^\d{1,19}$/.test(accountId)) throw new Error('用法：node scripts/follow/follow-stream.ts <list|subscribe|stream|run> <授权账号数字ID>');
if (command === 'run' && !useAppToken) throw new Error('run 需要 --app 以连接事件流');
if (useAppToken && !appToken) throw new Error('请在 .env 配置 X_ACTIVITY_APP_BEARER_TOKEN');
if (!useAppToken && (!existsSync('.data/accounts.sqlite') || !existsSync('.data/key'))) throw new Error('找不到账号数据库或加密密钥，请在项目目录运行并先完成授权');

const telemetry = monitorProcess(accountId, 'activity');
telemetry.stage('准备关注事件监听');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const api = makeActivityApi({ accountId, useAppToken, appToken, controller });

// 回关私信回复：串行执行，失败只记录不阻塞事件流。
const dmClient = new LocalDmClient();
let llm: any = null;
const llmConfigured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL && process.env.LLM_BASE_URL);
let llmWarningLogged = false;
function ensureLlm() { if (!llm) llm = makeLlm(); return llm; }
const customer = createCustomerService({ llm: ensureLlm, dm: dmClient, requireConnection: true });
let streamConnected = false;
const streamState = (state: string) => {
  const connected = state === '监听关注与回关事件';
  streamConnected = connected;
  customer.setConnection(connected);
  telemetry.stage(state, connected ? 'running' : 'waiting');
};
function welcome(account: string, peer: string, username: string) {
  if (llmConfigured || !customer.hasPin(account)) customer.queueWelcome(account, peer, username);
}
function welcomeCompletedFollows() {
  for (const item of completedInboundFollows()) welcome(item.account_id, item.target_id, item.username);
}

async function main() {
  if (command === 'run') {
    await withActivityStreamLock(async () => {
      customer.startFollowupMonitoring();
      console.log(await ensureFollowSubscription(api, accountId));
      const userApi = makeActivityApi({ accountId, useAppToken: false, controller });
      for (const eventType of ['dm.received', 'chat.received'] as const) {
        try { console.log(await ensureMessageSubscription(api, accountId, eventType, userApi)); }
        catch (error) { console.error(`${eventType} 订阅失败：${error instanceof Error ? error.message : String(error)}`); }
      }
      const timer = setInterval(() => { try { if (streamConnected) welcomeCompletedFollows(); } catch { console.error('检查已确认回关失败，将稍后重试。'); } }, 5000);
      try {
      await receiveFollowEvents(api, controller, (event) => {
        const eventMessage = JSON.stringify({ eventId: event.eventId, time: event.occurredAt, followerId: event.followerId, follower: event.followerUsername, accountId: event.accountId });
        if (event.accountId === accountId) console.log(eventMessage);
        {
          const { outcome, status, queued } = queueInboundFollow(event);
          if (event.accountId === accountId) console.log(`关注事件已保存：${outcome}`);
          else recordRuntimeEvent(event.accountId, `${eventMessage}\n关注事件已保存：${outcome}`);
          if (queued) console.log(`已将 @${event.followerUsername || event.followerId} 加入回关队列。`);
          if (status === 'following') {
            if (llmConfigured || !customer.hasPin(event.accountId)) welcome(event.accountId, event.followerId, event.followerUsername);
            else if (!llmConfigured && !llmWarningLogged) { llmWarningLogged = true; console.log('未配置 LLM，跳过回关私信回复。'); }
          }
        }
      }, streamState, event => { if (llmConfigured) customer.dm(event); }, event => { if (llmConfigured) customer.chat(event); });
      } finally { clearInterval(timer); }
    });
    return;
  }
  if (command === 'subscribe') {
    const response = await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'follow.follow', filter: { user_id: accountId, qualifiers: { direction: 'inbound' } }, tag: 'follow-stream-test' }) });
    console.log('订阅创建结果：', JSON.stringify(await response.json()));
    return;
  }
  if (command === 'list') {
    const response = await api(`/subscriptions?${new URLSearchParams({ user_id: accountId! })}`);
    console.log('订阅列表：', JSON.stringify(await response.json()));
    return;
  }
  // stream：只打印，不落库，内存去重。
  const seen = new Set<string>();
  await receiveFollowEvents(api, controller, (event) => {
    if (seen.has(event.eventId)) return;
    seen.add(event.eventId); if (seen.size > 10000) seen.delete(seen.values().next().value!);
    console.log(JSON.stringify({ eventId: event.eventId, time: event.occurredAt, followerId: event.followerId, follower: event.followerUsername, accountId: event.accountId }));
  }, streamState);
}

main().catch(error => { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } }).finally(async () => { await customer.close(); });
