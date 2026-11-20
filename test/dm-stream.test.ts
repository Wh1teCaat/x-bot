import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDmSubscription, ensureMessageSubscription, parseDmEvents, parseChatEvent, receiveFollowEvents } from '../scripts/follow/activity-stream.ts';

const event = { event_type: 'dm.received', event_uuid: 'delivery-1', filter: { user_id: '1' }, payload: { direct_message_events: [
  { type: 'message_create', id: '99', message_create: { sender_id: '2', target: { recipient_id: '1' }, message_data: { text: 'hello' } } },
  { type: 'message_create', id: '100', message_create: { sender_id: '1', target: { recipient_id: '1' }, message_data: { text: 'self' } } },
  { type: 'message_create', id: '101', message_create: { sender_id: '2', target: { recipient_id: '3' }, message_data: { text: 'other' } } },
] } };

test('DM parsing validates direction and dispatches the valid message from the stream', async () => {
  assert.deepEqual(parseDmEvents(event).map(m => m.messageId), ['99']);
  assert.deepEqual(parseDmEvents({ ...event, event_type: 'chat.received' }), []);
  const controller = new AbortController();
  const received: string[] = [];
  const api = async () => new Response(`${JSON.stringify({ data: event })}\n`);
  await receiveFollowEvents(api, controller, () => assert.fail('not a follow'), () => {}, dm => { received.push(dm.text); controller.abort(); });
  assert.deepEqual(received, ['hello']);
});

test('encrypted chat events are dispatched as metadata without exposing encoded content', async () => {
  const chat = { event_type: 'chat.received', event_uuid: 'delivery-2', filter: { user_id: '1' }, payload: { id: 'message-uuid', sender_id: '2', conversation_id: '1:2', encoded_event: 'ciphertext' } };
  assert.deepEqual(parseChatEvent(chat), { eventId: 'delivery-2', messageId: 'message-uuid', accountId: '1', senderId: '2', conversationId: '1:2' });
  assert.equal(parseChatEvent({ ...chat, payload: { ...chat.payload, sender_id: '1' } }), null);
  const controller = new AbortController();
  const received: string[] = [];
  await receiveFollowEvents(async () => new Response(`${JSON.stringify({ data: chat })}\n`), controller, () => {}, () => {}, () => assert.fail('not a DM'), msg => { received.push(msg.messageId); controller.abort(); });
  assert.deepEqual(received, ['message-uuid']);
});

test('chat subscription uses the user API for creation', async () => {
  let body: any;
  const list = async () => Response.json({ data: [] });
  const create = async (_path: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ data: { id: '1' } }); };
  await ensureMessageSubscription(list, '42', 'chat.received', create);
  assert.equal(body.event_type, 'chat.received');
  assert.equal(body.filter.user_id, '42');
});

test('one activity stream dispatches both DM and Chat events', async () => {
  const chat = { event_type: 'chat.received', event_uuid: 'delivery-2', filter: { user_id: '1' }, payload: { id: 'message-uuid', sender_id: '2', conversation_id: '1:2' } };
  const controller = new AbortController();
  const received: string[] = [];
  const body = [event, chat].map(data => JSON.stringify({ data })).join('\n') + '\n';
  await receiveFollowEvents(async () => new Response(body), controller, () => {}, () => {}, dm => received.push(`dm:${dm.messageId}`), message => { received.push(`chat:${message.messageId}`); controller.abort(); });
  assert.deepEqual(received, ['dm:99', 'chat:message-uuid']);
});

test('DM subscription reuses existing subscription or creates a private DM subscription', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let existing = false;
  const api = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === 'POST') return Response.json({ data: { id: '1' } });
    return Response.json({ data: existing ? [{ event_type: 'dm.received', filter: { user_id: '42' } }] : [] });
  };
  const creationCalls: Array<{ path: string; init?: RequestInit }> = [];
  const userApi = async (path: string, init?: RequestInit) => { creationCalls.push({ path, init }); return Response.json({ data: { id: '1' } }); };
  await ensureDmSubscription(api, '42', userApi);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(creationCalls[0].init?.body)).event_type, 'dm.received');
  assert.equal(JSON.parse(String(creationCalls[0].init?.body)).filter.user_id, '42');
  calls.length = 0;
  existing = true;
  await ensureDmSubscription(api, '42', userApi);
  assert.equal(calls.length, 1);
  assert.equal(creationCalls.length, 1);
});
