import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/account-store.ts';
import { createCustomerService } from '../scripts/follow/customer-service.ts';

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
    assert.deepEqual(sent, ['Please contact our service.']);
    const input = JSON.parse(prompts[0].messages[1].content);
    assert.equal(input.stage, '对方回复后');
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
