import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { RuntimeMonitor, safeLog } from '../src/runtime-monitor.ts';
import { readConsole } from '../src/console-data.ts';
import { FollowStore } from '../src/follow-store.ts';
import { FollowOutbox } from '../src/follow-outbox.ts';

function fixture() { const dir = mkdtempSync(join(tmpdir(), 'console-')); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
const accounts = [{ uuid: '1', username: 'alice', authenticated: true, accessToken: 'never-return-this' }, { uuid: '2', username: 'bob', authenticated: true }];

test('step duration uses transitions and repeated persistence does not reset start', () => {
  const f = fixture(); let now = 1000;
  const monitor = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'loop', () => now);
  try {
    monitor.stage('抓取粉丝'); now = 2000; monitor.stage('抓取粉丝');
    monitor.log('info', '读取 200 人'); now = 4500; monitor.stage('筛选');
    now = 5000; monitor.close();
    const result = readConsole(f.dir, accounts, { accountId: '1', now, alive: () => true });
    assert.equal(result.steps[1].durationMs, 3500);
    assert.equal(result.steps[0].durationMs, 500);
    assert.equal(result.logs[0].elapsedMs, 1000);
    assert.equal(result.accounts[0].status, 'completed');
    assert.ok(!JSON.stringify(result).includes('never-return-this'));
  } finally { if (!monitor.closed) monitor.close(); f.cleanup(); }
});

test('counts distinguish confirmed follows, pending, unique inbound and mutual; accounts stay isolated', () => {
  const f = fixture(); const store = new FollowStore(join(f.dir, 'following.sqlite')); const box = new FollowOutbox(join(f.dir, 'following.sqlite'));
  try {
    store.record('1', '10', 'following'); store.record('1', '11', 'pending'); store.record('1', '12', 'uncertain');
    store.record('2', '20', 'following');
    store.recordInboundFollow('e1', '1', '10'); store.recordInboundFollow('e2', '1', '10'); store.recordInboundFollow('e3', '1', '11');
    box.enqueue('1', [{ id: '30', username: 'user', source: 'test' }]);
    const result = readConsole(f.dir, accounts);
    assert.deepEqual(result.accounts[0].stats, { following: 1, pending: 1, uncertain: 1, inbound: 2, mutual: 1, queued: 1, manual: 0 });
    assert.equal(result.accounts[1].stats.mutual, 0);
    assert.equal(result.accounts[1].stats.queued, 0);
  } finally { box.close(); store.close(); f.cleanup(); }
});

test('dead or stale processes are interrupted and elapsed duration is unknown, not ever-growing', () => {
  const f = fixture(); const monitor = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'loop', () => 1000);
  try {
    monitor.stage('导出');
    for (const options of [{ now: 2000, alive: () => false }, { now: 50000, alive: () => true }]) {
      const result = readConsole(f.dir, accounts, { accountId: '1', ...options });
      assert.equal(result.accounts[0].status, 'interrupted');
      assert.equal(result.steps[0].status, 'interrupted');
      assert.equal(result.steps[0].durationMs, null);
    }
  } finally { monitor.close(); f.cleanup(); }
});

test('logs paginate without repeats and never leak another account or authentication fields', () => {
  const f = fixture(); const one = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'loop'); const two = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '2', 'loop');
  try {
    one.stage('筛选'); two.stage('另一个账号'); two.log('info', 'bob-private-log');
    for (let i = 0; i < 102; i++) one.log('info', `item ${i}`);
    one.log('error', 'Authorization: Bearer secret123');
    const first = readConsole(f.dir, accounts, { accountId: '1' });
    assert.equal(first.logs.length, 100);
    assert.ok(!JSON.stringify(first).includes('secret123'));
    assert.ok(!JSON.stringify(first).includes('bob-private-log'));
    const second = readConsole(f.dir, accounts, { accountId: '1', before: first.nextBefore! });
    assert.equal(second.logs.length, 3);
    assert.equal(second.nextBefore, null);
    assert.ok(second.logs.every(log => !first.logs.some(row => row.id === log.id)));
    assert.match(safeLog('{"auth_token":"secret"}'), /隐藏/);
  } finally { one.close(); two.close(); f.cleanup(); }
});

test('empty installation returns zero counts without creating any databases', () => {
  const f = fixture();
  try {
    const result = readConsole(f.dir, accounts);
    assert.equal(result.accounts[0].status, 'idle');
    assert.equal(result.accounts[0].stats.following, 0);
    assert.equal(existsSync(join(f.dir, 'runtime.sqlite')), false);
  } finally { f.cleanup(); }
});

test('old runs supply stage only, never invented timing or serialized candidate data', () => {
  const f = fixture(); const db = new DatabaseSync(join(f.dir, 'loop.sqlite'));
  try {
    db.exec('CREATE TABLE runs(id TEXT,status TEXT,stage TEXT,state TEXT,pid INTEGER,updated_at TEXT)');
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)').run('old', 'running', 'qualify', JSON.stringify({ followAccountId: '1', private: 'do-not-expose' }), 123, new Date().toISOString());
    const result = readConsole(f.dir, accounts, { accountId: '1', alive: () => true });
    assert.equal(result.accounts[0].fallback?.stage, '筛选关注/粉丝比例');
    assert.equal(result.steps.length, 0);
    assert.ok(!JSON.stringify(result).includes('do-not-expose'));
  } finally { db.close(); f.cleanup(); }
});

test('business child process console logs and terminal outcome reach the console', () => {
  const f = fixture();
  try {
    const moduleUrl = new URL('../src/runtime-monitor.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { monitorProcess } from ${JSON.stringify(moduleUrl)};
      const telemetry = monitorProcess('1', 'loop');
      telemetry.stage('读取粉丝');
      console.log('已读取 %d 人', 200);
      console.error('access_token=must-not-persist');
      telemetry.endStep('failed');
      process.exitCode = 1;
    `], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(child.status, 1);
    const result = readConsole(join(f.dir, '.data'), accounts, { accountId: '1' });
    assert.equal(result.accounts[0].status, 'failed');
    assert.equal(result.steps[0].status, 'failed');
    assert.ok(result.logs.some(log => log.message === '已读取 200 人'));
    assert.ok(!JSON.stringify(result).includes('must-not-persist'));
  } finally { f.cleanup(); }
});

test('long-running workers remain visible after many newer completed sessions', () => {
  const f = fixture(); let now = 1000;
  const monitor = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'outbox', () => now);
  try {
    monitor.stage('等待关注候选', 'waiting');
    for (let i = 0; i < 45; i++) {
      now += 1000;
      const completed = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'loop', () => now);
      completed.close();
    }
    monitor.heartbeat();
    const result = readConsole(f.dir, accounts, { accountId: '1', now, alive: () => true });
    assert.equal(result.accounts[0].status, 'running');
    assert.ok(result.accounts[0].sessions.some(s => s.worker === 'outbox' && s.status === 'running'));
  } finally { monitor.close(); f.cleanup(); }
});


test('a failed worker stays red while other workers run, then clears after recovery', () => {
  const f = fixture(); let now = 1000;
  const failed = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'login', () => now);
  const active = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'mirror', () => now);
  let recovered: RuntimeMonitor | undefined;
  try {
    failed.stage('需要验证'); failed.close('failed'); active.stage('监听帖子');
    let result = readConsole(f.dir, accounts, { now: 2000, alive: () => true });
    assert.equal(result.accounts[0].status, 'running');
    assert.equal(result.accounts[0].needsAttention, true);
    now = 3000; recovered = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'login', () => now);
    recovered.stage('登录成功'); recovered.close();
    result = readConsole(f.dir, accounts, { now: 4000, alive: () => true });
    assert.equal(result.accounts[0].needsAttention, false);
  } finally { if (!failed.closed) failed.close(); active.close(); if (recovered && !recovered.closed) recovered.close(); f.cleanup(); }
});
