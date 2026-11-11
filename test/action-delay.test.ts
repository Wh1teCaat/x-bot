/** 验证浏览器操作随机等待及访问计数的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionDelay, createProfileVisitDelay } from '../scripts/action-delay.ts';

test('adds a random delay within the requested inclusive range', async () => {
  const delays = [];
  const page = { waitForTimeout: async ms => delays.push(ms) };
  await actionDelay(page, () => 0);
  await actionDelay(page, () => 0.5);
  await actionDelay(page, () => 0.999999);
  assert.deepEqual(delays, [0, 500, 1000]);
});

test('waits only after every tenth profile visit', async () => {
  const delays = [];
  const visit = createProfileVisitDelay({ waitForTimeout: async ms => delays.push(ms) }, () => 0.999999);
  for (let i = 0; i < 21; i++) await visit();
  assert.deepEqual(delays, [5000, 5000]);
});
