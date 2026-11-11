/** 验证事件队列唤醒与空闲行为的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventWorkQueue } from '../scripts/event-work-queue.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('idle queue creates no timer and starts a newly enqueued job', async () => {
  const jobs = [], processed = [], timers = [];
  const store = { enqueue: async j => jobs.push(j), claimReady: async () => jobs.shift(), complete: async () => {}, fail: async () => {}, nextDue: async () => null };
  const queue = new EventWorkQueue({ store, handle: async j => processed.push(j), setTimer: (...x) => timers.push(x) });
  queue.start(); await tick(); assert.equal(timers.length, 0);
  await queue.enqueue('job'); await tick(); assert.deepEqual(processed, ['job']); queue.close();
});

test('new jobs wake the queue immediately even when a delayed retry is scheduled', async () => {
  const jobs = [], processed = []; let callback, cleared = false;
  const store = { enqueue: async j => jobs.push(j), claimReady: async () => jobs.shift(), complete: async () => {}, fail: async () => {}, nextDue: async () => 1000 };
  const queue = new EventWorkQueue({ store, handle: async j => processed.push(j), now: () => 0, setTimer: cb => { callback = cb; return 1; }, clearTimer: () => { cleared = true; } });
  queue.start(); await tick(); assert.ok(callback);
  await queue.enqueue('new'); await tick(); assert.equal(cleared, true); assert.deepEqual(processed, ['new']); queue.close();
});

test('an enqueue during an active job is not lost', async () => {
  const jobs = [], processed = []; let release;
  const store = { enqueue: async j => jobs.push(j), claimReady: async () => jobs.shift(), complete: async () => {}, fail: async () => {}, nextDue: async () => null };
  const queue = new EventWorkQueue({ store, handle: async j => { processed.push(j); if (j === 1) await new Promise(r => { release = r; }); } });
  await queue.enqueue(1); await tick(); await queue.enqueue(2); release(); await tick(); await tick();
  assert.deepEqual(processed, [1, 2]); queue.close();
});
