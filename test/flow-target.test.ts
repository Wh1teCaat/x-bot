/** 验证统一流程只复用已 clone 的持久化目标。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlowTarget } from '../scripts/loop/flow-target.ts';

const base = { cloned: false, copiedFromUsername: null } as any;

test('uses a persisted target for a cloned account', () => {
  assert.equal(resolveFlowTarget({ ...base, cloned: true, copiedFromUsername: 'YahooNewsTopics' }), 'YahooNewsTopics');
  assert.equal(resolveFlowTarget({ ...base, cloned: true, copiedFromUsername: 'YahooNewsTopics' }, '@yahoonewstopics'), 'YahooNewsTopics');
});

test('refuses to switch target on a cloned account', () => {
  assert.throws(() => resolveFlowTarget({ ...base, cloned: true, copiedFromUsername: 'YahooNewsTopics' }, 'other'), /不能直接更换目标/);
});

test('requires a target only before clone', () => {
  assert.throws(() => resolveFlowTarget(base), /尚未 clone/);
  assert.equal(resolveFlowTarget(base, '@YahooNewsTopics'), 'YahooNewsTopics');
});
