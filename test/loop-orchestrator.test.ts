/** 验证单轮队列、限流冷却和安全重试的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ResilienceStore } from '../scripts/loop/resilience.ts';
import { createLoopOrchestrator } from '../scripts/loop/loop-orchestrator.ts';

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, status TEXT, stage TEXT, state TEXT)');
  const resilience = new ResilienceStore(db);
  let now = 0, id = 0; const timers = new Map();
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => { const n = ++id; timers.set(n, { fn, due: now + ms }); return n; },
    clearTimer: n => timers.delete(n),
    async advance(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); timer.fn(); } await tick(); },
  };
  return { db, resilience, clock, timers };
}

test('search limit persists cooldown, retries probe after failure, then resumes the same run', async () => {
  const { db, resilience, clock } = setup(); let calls = 0, probes = 0;
  const loop = createLoopOrchestrator({ db, runId: 'run', ...clock, execute: async ({ resume }) => {
    calls++;
    if (calls === 1) {
      assert.equal(resume, false);
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('run', 'failed', 'search', '{"blogger":"test"}');
      resilience.open('x', '429'); resilience.failure('run', 'search', { kind: 'rate_limit', reason: '429', retryable: false }); return 1;
    }
    assert.equal(resume, true); assert.equal(resilience.circuit('x').state, 'closed');
    db.prepare("UPDATE runs SET status='completed',stage='done' WHERE id='run'").run(); return 0;
  }, probe: async () => ++probes === 2 });
  const done = loop.start(); await tick();
  assert.equal(calls, 1); assert.equal(db.prepare('SELECT next_at FROM cooldowns').get().next_at, 900000);
  await clock.advance(900000); assert.equal(probes, 1); assert.equal(calls, 1); assert.equal(resilience.circuit('x').state, 'open');
  await clock.advance(900000); assert.equal(await done, 'completed'); assert.equal(calls, 2); assert.equal(probes, 2);
  assert.equal(db.prepare('SELECT status FROM loop_jobs').get().status, 'done'); db.close();
});

test('never automatically repeats an interrupted export or follow', async () => {
  for (const stage of ['export', 'follow']) {
    const { db, resilience, clock } = setup(); let calls = 0;
    const loop = createLoopOrchestrator({ db, runId: stage, ...clock, probe: async () => { throw new Error('must not probe'); }, execute: async () => {
      calls++; db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(stage, 'failed', stage, '{}');
      resilience.failure(stage, stage, { kind: 'manual', reason: '需核实', retryable: false }); return 1;
    } });
    assert.equal(await loop.start(), 'manual'); await clock.advance(3600000); assert.equal(calls, 1); db.close();
  }
});

test('a temporary model failure stops for manual review instead of auto-retrying', async () => {
  const { db, resilience, clock } = setup(); let calls = 0;
  const loop = createLoopOrchestrator({ db, runId: 'retry', ...clock, probe: async () => false, execute: async () => {
    calls++; db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('retry', 'failed', 'evaluate', '{}');
    resilience.failure('retry', 'evaluate', { kind: 'transient', reason: 'timeout', retryable: true }); return 1;
  } });
  assert.equal(await loop.start(), 'manual'); await clock.advance(3600000);
  assert.equal(calls, 1); db.close();
});

test('restarts a persisted cooldown without launching the failed run early', async () => {
  const { db, resilience, clock } = setup(); let executions = 0;
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('resume', 'failed', 'search', '{"blogger":"test"}');
  resilience.open('x', '429');
  const options = { db, runId: 'resume', ...clock, execute: async () => { executions++; db.prepare("UPDATE runs SET status='completed',stage='done'").run(); return 0; } };
  const first = createLoopOrchestrator({ ...options, probe: async () => false });
  db.prepare("INSERT INTO loop_jobs(id,status) VALUES ('resume','cooldown')").run();
  const firstDone = first.start(); await tick(); first.close(); assert.equal(await firstDone, 'stopped');
  const second = createLoopOrchestrator({ ...options, probe: async () => true });
  const done = second.start(); await tick(); assert.equal(executions, 0);
  await clock.advance(900000); assert.equal(await done, 'completed'); assert.equal(executions, 1); db.close();
});

test('lookup rate limit persists the deadline and retries the same run without probing the page or writing follows', async () => {
  const { db, resilience, clock } = setup(); let calls = 0, probes = 0;
  const makeLoop = () => createLoopOrchestrator({ db, runId: 'follow', ...clock, probe: async () => { probes++; return false; }, execute: async ({ resume }) => {
    calls++;
    if (calls === 1) {
      assert.equal(resume, false);
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('follow', 'failed', 'follow-lookup', '{"lookupRetryAt":1200000}');
      resilience.failure('follow', 'follow-lookup', { kind: 'rate_limit', reason: '429', retryable: false }); return 1;
    }
    assert.equal(resume, true);
    db.prepare("UPDATE runs SET status='completed',stage='done'").run(); return 0;
  } });
  const first = makeLoop();
  const stopped = first.start(); await tick(); first.close();
  assert.equal(await stopped, 'stopped');
  const second = makeLoop();
  const done = second.start();
  await clock.advance(1199999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(await done, 'completed');
  assert.equal(probes, 0); assert.equal(calls, 2); assert.equal(resilience.circuit('x'), undefined); db.close();
});

test('a legacy cooldown with uncertain follow results stops for review', async () => {
  const { db, resilience, clock } = setup(); let calls = 0;
  const loop = createLoopOrchestrator({ db, runId: 'uncertain', ...clock, probe: async () => false, hasUncertain: async () => true, execute: async () => {
    calls++; return 1;
  } });
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('uncertain', 'failed', 'follow', '{"version":5}');
  db.prepare("INSERT INTO loop_jobs(id,status) VALUES ('uncertain','cooldown')").run();
  resilience.open('x', '429');
  assert.equal(await loop.start(), 'manual');
  await clock.advance(3600000); assert.equal(calls, 0); assert.equal(resilience.circuit('x').state, 'open'); db.close();
});
