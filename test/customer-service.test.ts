import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/account-store.ts';
import { createCustomerService } from '../scripts/follow/customer-service.ts';
import { generateCustomerReply, generateDmReply } from '../scripts/follow/dm-reply.ts';

test('DeepSeek 短私信关闭推理，其他模型不添加专有参数', async () => {
  const old = process.env.LLM_BASE_URL, requests: any[] = [];
  const client = { chat: { completions: { create: async (request: any) => { requests.push(request); return { choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] }; } } } };
  try {
    process.env.LLM_BASE_URL = 'https://api.deepseek.com/v1';
    await generateCustomerReply(client, [{ role: 'user', text: 'hello' }]);
    await generateDmReply(client, { username: 'alice' });
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.deepEqual(requests[1].thinking, { type: 'disabled' });
    process.env.LLM_BASE_URL = 'https://another.example/v1';
    await generateCustomerReply(client, [{ role: 'user', text: 'hello' }]);
    assert.equal('thinking' in requests[2], false);
  } finally { if (old === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = old; }
});

test('客服失败日志包含阶段和模型结束状态，不泄露消息或服务错误详情', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-errors-'));
  const logged: string[] = [], original = console.error;
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    console.error = (...args) => { logged.push(args.join(' ')); };
    const service = createCustomerService({ dataDir: dir,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'private model output' } }] }) } } }),
      dm: { send: async () => { throw new Error('must not send'); } },
    });
    service.dm({ eventId: 'e', messageId: '1', accountId: '1', senderId: '3', text: 'private message' });
    await service.drain(); await service.close();
    assert.match(logged[0], /阶段：生成回复；模型结束状态 length/);
    assert.doesNotMatch(logged[0], /private|4826/);
  } finally { console.error = original; rmSync(dir, { recursive: true, force: true }); }
});

test('customer messages are account-isolated, deduplicated across restarts and sent with conversation context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-'));
  try {
    const accounts = new AccountStore(dir);
    accounts.upsert({ uuid: '1', username: 'a', authenticated: true });
    accounts.upsert({ uuid: '2', username: 'b', authenticated: true });
    accounts.setXChatPin('1', '4826');
    accounts.close();
    const sent: string[] = [];
    const prompts: any[] = [];
    const llm = () => ({ chat: { completions: { create: async (request: any) => { prompts.push(request); return { choices: [{ finish_reason: 'stop', message: { content: 'Please contact our service.' } }] }; } } } });
    const make = () => createCustomerService({ dataDir: dir, llm, dm: { send: async (_a, _b, text) => { sent.push(text); } } });
    let service = make();
    assert.equal(service.reserveWelcome('1', '3'), true);
    assert.equal(service.reserveWelcome('1', '3'), false);
    service.recordWelcome('1', '3', 'hello');
    const incoming = { eventId: 'e', messageId: '9', accountId: '1', senderId: '3', text: 'Can you ship here?' };
    service.dm(incoming); service.dm(incoming);
    service.dm({ ...incoming, accountId: '2', messageId: '10' });
    await service.close();
    assert.equal(sent.length, 1); assert.match(sent[0], /WhatsApp.*\+852 5712 7467/);
    const input = JSON.parse(prompts[0].messages[1].content);
    assert.equal(input.stage, '第二条引导');
    assert.deepEqual(input.messages.map((m: any) => m.text), ['hello', 'Can you ship here?']);
    service = make(); service.dm(incoming); await service.close();
    assert.equal(sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('XChat decrypts via the matching account reader and prevents repeated failed unlocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-chat-'));
  try {
    const accounts = new AccountStore(dir);
    accounts.upsert({ uuid: '1', username: 'a', authenticated: true });
    accounts.setXChatPin('1', '4826'); accounts.close();
    let unlocks = 0; let sends = 0;
    const llm = () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] }) } } });
    const dm = { send: async () => { sends++; } };
    const createReader = async () => { unlocks++; throw new Error('unlock failure'); };
    const event = { eventId: 'e', messageId: 'm1', accountId: '1', senderId: '3', conversationId: '1:3', encodedEvent: 'cipher' };
    let service = createCustomerService({ dataDir: dir, llm, dm, createReader });
    service.chat(event); service.chat({ ...event, messageId: 'm2' });
    await service.close();
    service = createCustomerService({ dataDir: dir, llm, dm, createReader });
    service.chat({ ...event, messageId: 'm3' }); await service.close();
    assert.equal(unlocks, 1); assert.equal(sends, 0);
    const store = new AccountStore(dir); assert.equal(store.isXChatPinBlocked('1'), true); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verified XChat text is passed to the model and replied to through DM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-decrypt-'));
  try {
    const store = new AccountStore(dir);
    store.upsert({ uuid: '1', username: 'a', authenticated: true });
    store.setXChatPin('1', '4826'); store.close();
    let input: any; let recipient = '';
    const service = createCustomerService({ dataDir: dir,
      llm: () => ({ chat: { completions: { create: async (req: any) => { input = JSON.parse(req.messages[1].content); return { choices: [{ finish_reason: 'stop', message: { content: 'Please contact us.' } }] }; } } } }),
      dm: { send: async (_account, peer) => { recipient = peer; } },
      createReader: async (id, pin) => { assert.equal(id, '1'); assert.equal(new TextDecoder().decode(pin), '4826'); return { decrypt: async () => 'Can you ship here?', close: () => {} }; },
    });
    service.chat({ eventId: 'e', messageId: 'm', accountId: '1', senderId: '3', conversationId: '1:3', encodedEvent: 'cipher' });
    await service.close();
    assert.equal(input.messages[0].text, 'Can you ship here?');
    assert.equal(recipient, '3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an incoming message while a welcome is being generated suppresses the separate welcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-race-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const service = createCustomerService({ dataDir: dir, followUpMs: 60000,
      llm: () => ({ chat: { completions: { create: async (request: any) => {
        const stage = JSON.parse(request.messages[1].content).stage;
        if (stage === '回关后的第一条私信') { started(); await gate; }
        return { choices: [{ finish_reason: 'stop', message: { content: stage === '第二条引导' ? 'Nice to meet you!' : 'hello welcome' } }] };
      } } } }), dm: { send: async (_account, _peer, text) => { sent.push(text); } } });
    assert.equal(service.queueWelcome('1', '3', 'alice'), true);
    await entered;
    service.dm({ eventId: 'e', messageId: '1', accountId: '1', senderId: '3', text: 'Hello' });
    release(); await service.drain(); await service.close();
    assert.equal(sent.length, 1); assert.match(sent[0], /^Nice to meet you!.*WhatsApp.*\+852 5712 7467/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with a PIN, an incoming message immediately triggers the only WhatsApp introduction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-timer-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [];
    const service = createCustomerService({ dataDir: dir, followUpMs: 120,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello, welcome!' } }] }) } } }),
      dm: { send: async (_account, _peer, text) => { sent.push(text); } } });
    service.queueWelcome('1', '3', 'alice'); await service.drain();
    await new Promise(resolve => setTimeout(resolve, 30));
    service.dm({ eventId: 'e', messageId: '1', accountId: '1', senderId: '3', text: 'I am interested' });
    await service.drain();
    await new Promise(resolve => setTimeout(resolve, 220)); await service.drain();
    assert.equal(sent.length, 2);
    assert.match(sent[1], /WhatsApp.*\+852 5712 7467/);
    await new Promise(resolve => setTimeout(resolve, 150)); await service.drain();
    assert.equal(sent.length, 2);
    await service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after the delayed introduction, a detail question is answered without another timer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-detail-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [], stages: string[] = [];
    const service = createCustomerService({ dataDir: dir, followUpMs: 40,
      llm: () => ({ chat: { completions: { create: async (req: any) => {
        const stage = JSON.parse(req.messages[1].content).stage; stages.push(stage);
        return { choices: [{ finish_reason: 'stop', message: { content: stage === '引导后回复' ? 'Please add our WhatsApp customer service at +852 5712 7467 for product details.' : 'hello, nice to meet you!' } }] };
      } } } }), dm: { send: async (_a, _b, text) => { sent.push(text); } } });
    service.queueWelcome('1', '3', 'alice'); await service.drain();
    await new Promise(resolve => setTimeout(resolve, 90)); await service.drain();
    assert.equal(sent.length, 2); assert.match(sent[1], /WhatsApp/);
    service.dm({ eventId: 'e', messageId: '2', accountId: '1', senderId: '3', text: 'What is the price?' });
    await service.drain(); await new Promise(resolve => setTimeout(resolve, 90)); await service.drain();
    assert.equal(stages.at(-1), '引导后回复'); assert.equal(sent.length, 3); assert.match(sent[2], /WhatsApp.*\+852 5712 7467/);
    await service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without a PIN the welcome and WhatsApp invitation are a single message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-one-message-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.close();
    const sent: string[] = [], stages: string[] = [];
    const service = createCustomerService({ dataDir: dir, followUpMs: 20,
      llm: () => ({ chat: { completions: { create: async (request: any) => { stages.push(JSON.parse(request.messages[1].content).stage); return { choices: [{ finish_reason: 'stop', message: { content: 'hello welcome' } }] }; } } } }),
      dm: { send: async (_account, _peer, text) => { sent.push(text); } } });
    service.queueWelcome('1', '3', 'alice'); await service.drain();
    service.dm({ eventId: 'e', messageId: '1', accountId: '1', senderId: '3', text: 'Hi' });
    await new Promise(resolve => setTimeout(resolve, 70)); await service.drain(); await service.close();
    assert.deepEqual(stages, []); assert.equal(sent.length, 1); assert.match(sent[0], /^hello.*WhatsApp.*\+852 5712 7467.*\.$/);
    assert.equal((sent[0].match(/[.!?]/g) || []).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stream interruption prevents a follow-up when a reply might have been missed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-disconnected-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [];
    const service = createCustomerService({ dataDir: dir, followUpMs: 40, requireConnection: true,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] }) } } }),
      dm: { send: async (_a, _b, text) => { sent.push(text); } } });
    service.startFollowupMonitoring(); service.setConnection(true);
    service.queueWelcome('1', '3', 'alice'); await service.drain();
    service.setConnection(false);
    await new Promise(resolve => setTimeout(resolve, 60));
    service.setConnection(true);
    await new Promise(resolve => setTimeout(resolve, 70)); await service.drain();
    assert.equal(sent.length, 1);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'customer-service.sqlite'));
    assert.equal((db.prepare('SELECT state FROM customer_followups').get() as any).state, 'unverified'); db.close();
    await service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pending follow-up remains scheduled across a clean service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-restart-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [];
    const make = () => createCustomerService({ dataDir: dir, followUpMs: 70,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] }) } } }),
      dm: { send: async (_a, _b, text) => { sent.push(text); } } });
    let service = make(); service.queueWelcome('1', '3', 'alice'); await service.drain(); await service.close();
    service = make(); await new Promise(resolve => setTimeout(resolve, 130)); await service.drain(); await service.close();
    assert.equal(sent.length, 2); assert.match(sent[1], /WhatsApp/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production monitoring does not send pending follow-ups after an offline restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-offline-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [];
    const opts = { dataDir: dir, followUpMs: 40, requireConnection: true,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] }) } } }),
      dm: { send: async (_a: string, _b: string, text: string) => { sent.push(text); } } };
    let service = createCustomerService(opts); service.startFollowupMonitoring(); service.setConnection(true);
    service.queueWelcome('1', '3', 'alice'); await service.drain(); await service.close();
    await new Promise(resolve => setTimeout(resolve, 60));
    service = createCustomerService(opts); service.startFollowupMonitoring(); service.setConnection(true);
    await new Promise(resolve => setTimeout(resolve, 80)); await service.drain(); await service.close();
    assert.equal(sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧版本为后续普通回复设置的定时器不会在升级后发送', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-old-timer-'));
  try {
    const store = new AccountStore(dir); store.upsert({ uuid: '1', username: 'a', authenticated: true }); store.setXChatPin('1', '4826'); store.close();
    const sent: string[] = [];
    const options = { dataDir: dir, followUpMs: 10000,
      llm: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'hello there' } }] }) } } }),
      dm: { send: async (_a: string, _b: string, text: string) => { sent.push(text); } } };
    const initial = createCustomerService(options); initial.queueWelcome('1', '3', 'alice'); await initial.drain(); await initial.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'customer-service.sqlite'));
    const later = db.prepare("INSERT INTO messages(account_id,peer_id,event_key,role,text,state,created_at) VALUES('1','3',NULL,'assistant','ordinary reply','sent',?)").run(new Date().toISOString());
    db.prepare("UPDATE customer_followups SET anchor_id=?,due_at=?,state='pending'").run(later.lastInsertRowid, Date.now() - 1); db.close();
    const restored = createCustomerService(options); await new Promise(resolve => setTimeout(resolve, 50)); await restored.drain(); await restored.close();
    assert.equal(sent.length, 1);
    const verify = new DatabaseSync(join(dir, 'customer-service.sqlite'));
    assert.equal((verify.prepare('SELECT state FROM customer_followups').get() as any).state, 'cancelled'); verify.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
