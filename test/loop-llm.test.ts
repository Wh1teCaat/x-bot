/** 验证模型候选评估校验的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidates } from '../scripts/loop/loop-llm.ts';
function client(content) { return { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) } } }; }
test('requires one valid decision for every candidate', async () => {
  const candidates = [{ username: 'a', profileUrl: 'https://x.com/a', replies: ['hello'] }];
  const results = await evaluateCandidates(client('{"items":[{"id":0,"decision":"uncertain","reason":"insufficient evidence"}]}'), candidates, 'target');
  assert.equal(results[0].review, 'pending');
  await assert.rejects(evaluateCandidates(client('{"items":[]}'), candidates, 'target'));
  await assert.rejects(evaluateCandidates(client('{"items":[{"id":1,"decision":"relevant","reason":"x"}]}'), candidates, 'target'));
});
