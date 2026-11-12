/** 验证故障分类、熔断与有界重试的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifyFailure, ResilienceStore, retryTransient } from '../scripts/loop/resilience.ts';

test('never automatically retries actions with uncertain external effects', () => {
  assert.equal(classifyFailure({ code: 'ETIMEDOUT' }, 'follow').retryable, false);
  assert.equal(classifyFailure({ status: 429 }, 'follow').kind, 'rate_limit');
  assert.equal(classifyFailure({ status: 503 }, 'evaluate').retryable, true);
  assert.equal(classifyFailure({ status: 403 }, 'evaluate').retryable, false);
});

test('bounded retry applies only to transient errors', async () => {
  let count = 0; const sleeps = [];
  const result = await retryTransient(async () => { if (++count < 3) throw Object.assign(new Error('server'), { status: 503 }); return 'ok'; }, { sleep: async ms => sleeps.push(ms) });
  assert.equal(result, 'ok'); assert.deepEqual(sleeps, [1000, 2000]);
  count = 0;
  await assert.rejects(retryTransient(async () => { count++; throw Object.assign(new Error('limited'), { status: 429 }); }, { sleep: async () => {} }));
  assert.equal(count, 1);
});

test('circuit and failure queue persist and require explicit reset', () => {
  const db = new DatabaseSync(':memory:'); const store = new ResilienceStore(db);
  store.open('x', '429'); assert.throws(() => store.ensureClosed('x'), /熔断/);
  store.failure('run', 'follow', { kind: 'manual', reason: '核实', retryable: false });
  store.failure('run', 'follow', { kind: 'manual', reason: '核实', retryable: false });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM failure_jobs').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM failure_jobs').get().status, 'manual');
  store.failure('run2', 'evaluate', { kind: 'transient', reason: '服务暂时异常', retryable: true });
  store.failure('run2', 'evaluate', { kind: 'transient', reason: '服务暂时异常', retryable: true });
  store.failure('run2', 'evaluate', { kind: 'transient', reason: '服务暂时异常', retryable: true });
  assert.deepEqual({ ...db.prepare("SELECT status,attempts FROM failure_jobs WHERE run_id='run2'").get() }, { status: 'dead', attempts: 3 });
  store.close('x'); store.ensureClosed('x'); store.resolve('run', 'follow');
  assert.equal(db.prepare("SELECT status FROM failure_jobs WHERE run_id='run'").get().status, 'resolved'); db.close();
});
