import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ExporterRetry, isRetryableExporterError } from '../scripts/browser/exporter-retry.ts';
import { classifyFailure } from '../scripts/loop/resilience.ts';

test('exporter retry persists 5, 10 and 15 minute waits, then resets after success', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 1000, calls = 0;
    const retry = new ExporterRetry(db, 'exporter:1', () => now, () => 0);
    const value = await retry.run(async () => { if (++calls <= 3) throw new Error('exporter24 rate limit'); return 'ok'; }, { guard: () => {}, sleep: async ms => { now += ms; } });
    assert.equal(value, 'ok'); assert.equal(now, 1000 + 5 * 60_000 + 10 * 60_000 + 15 * 60_000);
    assert.equal(retry.get(), undefined);
  } finally { db.close(); }
});

test('exporter stops after repeated failures and distinguishes X failures', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 0, guardCalls = 0;
    const retry = new ExporterRetry(db, 'exporter:1', () => now, () => 0);
    await assert.rejects(retry.run(async () => { throw new Error('exporter24 timeout'); }, { guard: () => {}, sleep: async ms => { now += ms; } }), /重试次数已耗尽/);
    assert.equal(new ExporterRetry(db, 'exporter:1').get()?.state, 'manual');
    assert.equal(isRetryableExporterError(new Error('登录失效')), false);
    assert.equal(isRetryableExporterError(new Error('rate limit')), true);
    assert.equal(classifyFailure({ source: 'exporter', message: 'rate limit' }, 'followers-export').kind, 'exporter');
    const other = new ExporterRetry(db, 'exporter:2', () => now, () => 0);
    await assert.rejects(other.run(async () => { throw new Error('timeout'); }, { guard: () => { if (++guardCalls > 1) throw new Error('X 熔断已开启'); } }), /X 熔断/);
    assert.equal(other.get(), undefined);
  } finally { db.close(); }
});

test('unsafe stopped task is not retried', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const retry = new ExporterRetry(db, 'exporter:1');
    await assert.rejects(retry.run(async () => { throw new Error('timeout'); }, { guard: () => {}, safeToRetry: async () => false }), /无法确认/);
    assert.equal(retry.get()?.state, 'manual');
  } finally { db.close(); }
});
