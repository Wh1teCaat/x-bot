import '../../src/runtime-config.ts';
/** 独立的 X Activity 关注事件测试；run 子命令接入回关落库与私信回复。 */

import { monitorProcess, recordRuntimeEvent } from '../../src/runtime-monitor.ts';
import { existsSync } from 'node:fs';
import { FollowStore } from '../../src/follow-store.ts';
import { makeLlm } from '../loop/loop-llm.ts';
import { generateDmReply, LocalDmClient, createReplyDispatcher } from './dm-reply.ts';
import { makeActivityApi, ensureFollowSubscription, receiveFollowEvents, withActivityStreamLock } from './activity-stream.ts';

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
const streamState = (state: string) => telemetry.stage(state, 'waiting');
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
const dispatcher = createReplyDispatcher({
  generate: (follower) => generateDmReply(ensureLlm(), follower),
  send: (accountId, recipientId, text) => dmClient.send(accountId, recipientId, text),
});

async function main() {
  if (command === 'run') {
    await withActivityStreamLock(async () => {
      console.log(await ensureFollowSubscription(api, accountId));
      await receiveFollowEvents(api, controller, (event) => {
        const eventMessage = JSON.stringify({ eventId: event.eventId, time: event.occurredAt, followerId: event.followerId, follower: event.followerUsername, accountId: event.accountId });
        if (event.accountId === accountId) console.log(eventMessage);
        const store = new FollowStore('.data/following.sqlite');
        try {
          const outcome = store.recordInboundFollow(event.eventId, event.accountId, event.followerId, event.occurredAt);
          if (event.accountId === accountId) console.log(`关注事件已保存：${outcome}`);
          else recordRuntimeEvent(event.accountId, `${eventMessage}\n关注事件已保存：${outcome}`);
          if (outcome !== '重复事件') {
            if (llmConfigured) dispatcher.enqueue(event.accountId, event.followerId, event.followerUsername);
            else if (!llmWarningLogged) { llmWarningLogged = true; console.log('未配置 LLM，跳过回关私信回复。'); }
          }
        } finally { store.close(); }
      }, streamState);
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

main().catch(error => { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } });
