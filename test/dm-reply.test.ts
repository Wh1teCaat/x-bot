/** 验证回关欢迎私信生成与本地发送客户端的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureHello, generateDmReply, LocalDmClient, createReplyDispatcher } from '../scripts/follow/dm-reply.ts';

function client(content: string, finishReason = 'stop') {
  return { chat: { completions: { create: async () => ({ choices: [{ finish_reason: finishReason, message: { content } }] }) } } };
}

test('ensureHello keeps an existing hello first word and prepends it otherwise', () => {
  assert.equal(ensureHello('hello world'), 'hello world');
  assert.equal(ensureHello('Hello, nice to meet you'), 'Hello, nice to meet you');
  assert.equal(ensureHello('hi there'), 'hello hi there');
  assert.equal(ensureHello('  hello   '), 'hello');
});

test('generateDmReply always starts with hello and rejects incomplete responses', async () => {
  assert.equal(await generateDmReply(client('Hi there!'), { username: 'alice' }), 'hello Hi there!');
  assert.equal(await generateDmReply(client('hello world'), { username: 'alice' }), 'hello world');
  await assert.rejects(generateDmReply(client('   '), { username: 'alice' }), /未返回完整私信/);
  await assert.rejects(generateDmReply(client('hello', 'length'), { username: 'alice' }), /未返回完整私信/);
});

test('welcome generation loads the conversation skill and identifies the greeting stage', async () => {
  let request: any;
  const llm = { chat: { completions: { create: async (input: any) => {
    request = input;
    return { choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] };
  } } } };
  await generateDmReply(llm, { username: 'alice' });
  assert.match(request.messages[0].content, /\+852 5712 7467/);
  assert.match(request.messages[0].content, /不要询问购买意向/);
  assert.deepEqual(JSON.parse(request.messages[1].content), { stage: '回关后的第一条私信', username: 'alice' });
  request = undefined;
  assert.match(await generateDmReply(llm, { username: 'alice' }, '一次性欢迎'), /\+852 5712 7467/);
  assert.equal(request, undefined, '无 PIN 欢迎不调用模型');
});

test('LocalDmClient sends a DM through the local service and validates ids', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const dm = new LocalDmClient({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { dm_event_id: 'ev-1' } }));
    },
  });
  const result = await dm.send('1', '123', 'hello there');
  assert.deepEqual(result, { data: { dm_event_id: 'ev-1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/accounts/1/messages');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-Local-Request'], '1');
  assert.equal(JSON.parse(String(calls[0].init.body)).text, 'hello there');
  await assert.rejects(dm.send('bad', '123', 'hello'), /账号 ID 无效/);
  await assert.rejects(dm.send('1', 'bad', 'hello'), /账号 ID 无效/);
});

test('createReplyDispatcher serializes, dedupes and continues after a failure', async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const dispatcher = createReplyDispatcher({
    generate: async (follower) => `hello ${follower.username}`,
    send: async (_accountId, recipientId, text) => {
      if (recipientId === '2') throw new Error('boom');
      sent.push(text);
    },
    onError: (message) => errors.push(message),
    onSent: () => {},
  });
  dispatcher.enqueue('a', '1', 'alice');
  dispatcher.enqueue('a', '1', 'alice'); // 去重
  dispatcher.enqueue('a', '2', 'bob');   // 发送失败，不应阻塞后续
  dispatcher.enqueue('a', '3', 'carol');
  await dispatcher.drain();
  assert.deepEqual(sent, ['hello alice', 'hello carol']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boom/);
  assert.equal(dispatcher.pending(), 0);
});
