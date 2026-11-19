import '../../src/runtime-config.ts';
/** 独立的回关监听 + 私信回复命令：npm run follow-reply -- <账号数字ID> [--mock] [--app]。 */

import { monitorProcess, recordRuntimeEvent } from '../../src/runtime-monitor.ts';
import { existsSync } from 'node:fs';
import { FollowStore } from '../../src/follow-store.ts';
import { makeLlm } from '../loop/loop-llm.ts';
import { ensureHello, generateDmReply, LocalDmClient, createReplyDispatcher } from './dm-reply.ts';
import { makeActivityApi, ensureFollowSubscription, receiveFollowEvents, withActivityStreamLock } from './activity-stream.ts';

const accountId = process.argv[2];
const mock = process.argv.includes('--mock');
const useAppToken = process.argv.includes('--app');
const appToken = process.env.X_ACTIVITY_APP_BEARER_TOKEN;
if (!/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run follow-reply -- <账号数字ID> [--mock] [--app]');
  process.exit(1);
}
if (!mock && useAppToken && !appToken) throw new Error('请在 .env 配置 X_ACTIVITY_APP_BEARER_TOKEN');
if (!mock && !useAppToken && (!existsSync('.data/accounts.sqlite') || !existsSync('.data/key'))) throw new Error('找不到账号数据库或加密密钥，请先完成授权，或使用 --app 连接应用流');

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

/** 不访问 X、不调用真实 LLM、不写真实数据库的端到端自测。 */
async function runMockSelfTest(accountId: string): Promise<void> {
  console.log('=== 回关私信回复 mock 自测（不访问 X、不调用真实 LLM、不写真实数据库） ===\n');

  console.log('1) ensureHello 首句兜底:');
  const helloCases: Array<[string, string]> = [
    ['hello world', 'hello world'],
    ['Hi there!', 'hello Hi there!'],
    ['Hello, nice to meet you', 'Hello, nice to meet you'],
  ];
  for (const [input, expected] of helloCases) {
    const got = ensureHello(input);
    if (got !== expected) throw new Error(`ensureHello(${JSON.stringify(input)}) 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`);
    console.log(`   ${JSON.stringify(input)} -> ${JSON.stringify(got)} ✓`);
  }

  console.log('\n2) 私信生成（mock LLM）:');
  const mockGenerate = async (follower: { username: string }) => ensureHello(`there, thanks for following, ${follower.username || 'friend'}!`);
  const generated = await mockGenerate({ username: 'alice' });
  console.log(`   生成: ${JSON.stringify(generated)}`);
  if (!/^hello\b/i.test(generated)) throw new Error('生成结果未以 hello 开头');

  console.log('\n3) dispatcher 全链路（事件去重 → 生成 → 发送）:');
  const sent: Array<{ accountId: string; recipientId: string; text: string }> = [];
  const store = new FollowStore(':memory:');
  const dispatcher = createReplyDispatcher({
    generate: mockGenerate,
    send: async (acct, recipientId, text) => { sent.push({ accountId: acct, recipientId, text }); },
    onError: (m) => console.log('   [error]', m),
    onSent: (m) => console.log('   [sent]', m),
  });
  const events = [
    { eventId: 'mock-e1', accountId, followerId: '1001', followerUsername: 'alice' },
    { eventId: 'mock-e1', accountId, followerId: '1001', followerUsername: 'alice' }, // 重复事件
    { eventId: 'mock-e2', accountId, followerId: '1002', followerUsername: 'bob' },
  ];
  for (const ev of events) {
    const outcome = store.recordInboundFollow(ev.eventId, ev.accountId, ev.followerId, undefined);
    if (outcome === '重复事件') { console.log(`   [skip] 重复事件 ${ev.eventId}`); continue; }
    dispatcher.enqueue(ev.accountId, ev.followerId, ev.followerUsername);
  }
  await dispatcher.drain();
  store.close();

  if (sent.length !== 2) throw new Error(`期望发送 2 条，实际 ${sent.length} 条`);
  if (sent[0].recipientId !== '1001' || sent[1].recipientId !== '1002') throw new Error('发送对象或顺序错误');
  console.log(`   实际发送 ${sent.length} 条: ${sent.map(s => s.text).join(' | ')}`);

  console.log('\n=== mock 自测全部通过 ✓ ===');
}

/** 真实模式：订阅入站关注 + 落库 + 生成并发送私信。 */
async function runReal(accountId: string): Promise<void> {
  const telemetry = monitorProcess(accountId, 'activity');
  telemetry.stage('准备回关与私信监听');
  await withActivityStreamLock(async () => {
    const api = makeActivityApi({ accountId, useAppToken, appToken, controller });

    const dmClient = new LocalDmClient();
    let llm: any = null;
    const llmConfigured = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL && process.env.LLM_BASE_URL);
    let llmWarningLogged = false;
    const ensureLlm = () => { if (!llm) llm = makeLlm(); return llm; };
    const dispatcher = createReplyDispatcher({
      generate: (follower) => generateDmReply(ensureLlm(), follower),
      send: (acct, recipientId, text) => dmClient.send(acct, recipientId, text),
    });

    console.log(await ensureFollowSubscription(api, accountId));
    if (!llmConfigured) console.log('未配置 LLM_API_KEY/LLM_MODEL/LLM_BASE_URL，只监听落库、不发送回关私信。');

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
    }, state => telemetry.stage(state, state === '监听关注与回关事件' ? 'running' : 'waiting'));
  });
}

async function main() {
  if (mock) {
    await runMockSelfTest(accountId);
    process.exit(0);
  }
  await runReal(accountId);
}

main().catch(error => { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } });
