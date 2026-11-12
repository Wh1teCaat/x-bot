/** 验证限流冷却与探测时间持久化的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitCooldown } from '../scripts/loop/rate-limit-cooldown.ts';

test('waits 15 minutes, reschedules on failure and clears only after recovery', async () => {
  let clock = 0, next = null, result = false, recovered = 0; const delays = [];
  const store = { setNext: async n => { next = n; }, getNext: async () => next, clear: async () => { next = null; } };
  const c = new RateLimitCooldown({ store, now: () => clock, probe: async () => result, onRecovered: () => { recovered++; }, setTimer: (_, delay) => { delays.push(delay); return delays.length; }, clearTimer: () => {} });
  await c.limited(); assert.equal(next, 900000); assert.deepEqual(delays, [900000]);
  clock = 900000; await c.check(); assert.equal(next, 1800000); assert.deepEqual(delays, [900000, 900000]);
  clock = 1800000; result = true; await c.check(); assert.equal(next, null); assert.equal(recovered, 1); c.close();
});

test('cooldown deadline persists when store is recreated', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteCooldownStore } = await import('../scripts/loop/rate-limit-cooldown.ts');
  const db = new DatabaseSync(':memory:');
  await new SqliteCooldownStore(db, 'x').setNext(900000);
  assert.equal(await new SqliteCooldownStore(db, 'x').getNext(), 900000);
  await new SqliteCooldownStore(db, 'x').clear();
  assert.equal(await new SqliteCooldownStore(db, 'x').getNext(), null);
  db.close();
});
