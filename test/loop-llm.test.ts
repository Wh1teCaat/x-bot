/** 验证模型关键词与候选评估校验的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyword, evaluateCandidates } from '../scripts/loop-llm.ts';
function client(content) { return { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) } } }; }
test('accepts a plain keyword and rejects query operators', async () => {
  assert.equal(await generateKeyword(client('{"keyword":"Saudi Arabia"}'), 'target'), 'Saudi Arabia');
  await assert.rejects(generateKeyword(client('{"keyword":"from:someone"}'), 'target'));
});
test('requires one valid decision for every candidate', async () => {
  const candidates = [{ username: 'a', profileUrl: 'https://x.com/a', location: 'Riyadh', replies: ['hello'], matchedKeywords: [] }];
  const results = await evaluateCandidates(client('{"items":[{"id":0,"decision":"uncertain","reason":"insufficient evidence"}]}'), candidates, 'target');
  assert.equal(results[0].review, 'pending');
  await assert.rejects(evaluateCandidates(client('{"items":[]}'), candidates, 'target'));
  await assert.rejects(evaluateCandidates(client('{"items":[{"id":1,"decision":"relevant","reason":"x"}]}'), candidates, 'target'));
});
