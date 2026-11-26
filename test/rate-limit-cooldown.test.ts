/** 验证限流冷却与探测时间持久化的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RateLimitCooldown, SqliteCooldownStore } from '../scripts/loop/rate-limit-cooldown.ts';

test('waits 15 minutes, reschedules on failure and clears only after recovery', async () => {
  const db = new DatabaseSync(':memory:');
  let clock = 0, result = false, recovered = 0; const delays = [];
  const store = new SqliteCooldownStore(db, 'x');
  const c = new RateLimitCooldown({ store, now: () => clock, probe: async () => result, onRecovered: () => { recovered++; }, setTimer: (_, delay) => { delays.push(delay); return delays.length; }, clearTimer: () => {} });
  await c.limited(); assert.equal(await store.getNext(), 900000); assert.deepEqual(delays, [900000]);
  clock = 900000; await c.check(); assert.equal(await store.getNext(), 1800000); assert.deepEqual(delays, [900000, 900000]);
  clock = 1800000; result = true; await c.check(); assert.equal(await store.getNext(), null); assert.equal(recovered, 1); c.close();
  db.close();
});

test('cooldown deadline persists when store is recreated', async () => {
  const db = new DatabaseSync(':memory:');
  await new SqliteCooldownStore(db, 'x').setNext(900000);
  assert.equal(await new SqliteCooldownStore(db, 'x').getNext(), 900000);
  await new SqliteCooldownStore(db, 'x').clear();
  assert.equal(await new SqliteCooldownStore(db, 'x').getNext(), null);
  db.close();
});

test('shared cooldown ignores stale deadlines and invalidates an in-flight probe after a new limit', async () => {
  const db = new DatabaseSync(':memory:');
  let time = 0, primaryProbes = 0, observerProbes = 0, completeProbe: (ok: boolean) => void;
  const options = { now: () => time, intervalMs: 100, setTimer: () => 1, clearTimer: () => {} };
  const primary = new RateLimitCooldown({
    ...options, store: new SqliteCooldownStore(db, 'x'),
    probe: () => { primaryProbes++; return new Promise(resolve => { completeProbe = resolve; }); },
  });
  const observer = new RateLimitCooldown({
    ...options, store: new SqliteCooldownStore(db, 'x'),
    probe: async () => { observerProbes++; return true; },
  });
  await primary.limited();
  time = 50; await observer.limited();
  time = 100; await primary.check();
  assert.equal(primaryProbes, 0);
  assert.equal(await primary.store.getNext(), 150);
  time = 150;
  const checking = primary.check();
  await observer.check();
  assert.equal(primaryProbes, 1);
  assert.equal(observerProbes, 0);
  time = 175; await observer.limited();
  completeProbe(true); await checking;
  assert.equal(await primary.store.getNext(), 275);
  time = 275; await observer.check();
  assert.equal(observerProbes, 1);
  assert.equal(await primary.store.getNext(), null);
  primary.close(); observer.close(); db.close();
});
