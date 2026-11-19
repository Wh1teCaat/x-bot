import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { RuntimeMonitor, safeLog } from '../src/runtime-monitor.ts';
import { readConsole, groupConsoleSteps, stepPhase } from '../src/console-data.ts';
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

test('failed or manually stopped flow takes precedence over later child session completion', () => {
  for (const status of ['failed', 'stopped']) {
    const f = fixture(); let now = 1000;
    const flow = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'flow', () => now);
    now = 2000;
    const child = new RuntimeMonitor(join(f.dir, 'runtime.sqlite'), '1', 'loop', () => now);
    child.close('completed'); now = 3000; flow.close(status);
    try { assert.equal(readConsole(f.dir, accounts, { now, alive: () => false }).accounts[0].status, status); }
    finally { f.cleanup(); }
  }
});

test('console phases merge fine steps into preprocessing, post scan and follower scan', () => {
  const t = 1_000_000;
  const step = (id: number, sessionId: string, worker: string, name: string, status: string, startedAt: number, endedAt: number | null, durationMs: number | null) => ({ id, sessionId, worker, name, status, startedAt, endedAt, durationMs });
  // readConsole 返回的步骤是新到旧；groupConsoleSteps 自己按开始时间排序。
  const phases = groupConsoleSteps([
    step(9, 'followers', 'loop', '抓取粉丝（200 人） · 粉丝', 'running', t + 9000, null, 1000),
    step(8, 'posts', 'loop', '写入关注队列 · 帖子 2/2', 'completed', t + 8000, t + 8200, 200),
    step(7, 'posts', 'loop', '筛选关注/粉丝比例 · 帖子 2/2', 'completed', t + 7000, t + 7400, 400),
    step(6, 'posts', 'loop', '整理候选用户 · 帖子 2/2', 'completed', t + 6000, t + 6100, 100),
    step(5, 'posts', 'loop', '抓取帖子回复 · 帖子 1/2', 'completed', t + 3000, t + 5000, 2000),
    step(4, 'posts', 'loop', '准备采集任务', 'completed', t + 2000, t + 2100, 100),
    step(3, 'login', 'login', '等待采集任务完成', 'failed', t + 1900, t + 9500, 7600),
    step(2, 'login', 'login', '检查登录与浏览器', 'completed', t + 1000, t + 1200, 200),
    step(1, 'outbox', 'outbox', '关注 @alice', 'completed', t + 500, t + 600, 100),
  ], t + 10_000);

  assert.deepEqual(phases.map(phase => phase.name), ['扫描粉丝', '帖子扫描并关注', '预处理', '预处理', '执行关注队列']);
  assert.equal(phases[0].status, 'running');
  assert.equal(phases[0].durationMs, 1000);
  assert.equal(phases[1].startedAt, t + 3000);
  assert.equal(phases[1].endedAt, t + 8200);
  assert.equal(phases[1].durationMs, 2700);
  assert.equal(phases[1].status, 'completed');
  assert.equal(phases[2].durationMs, 100);
  assert.equal(phases[3].durationMs, 200, '等待采集任务完成的等待步骤不计入预处理');
  // “筛选关注/粉丝比例”虽含“粉丝”，仍属于帖子扫描，不能误判成扫描粉丝。
  assert.equal(stepPhase({ worker: 'loop', name: '筛选关注/粉丝比例 · 帖子 3/10' }), '帖子扫描并关注');
  assert.equal(stepPhase({ worker: 'loop', name: '抓取粉丝（200 人） · 粉丝' }), '扫描粉丝');
  assert.equal(stepPhase({ worker: 'activity', name: '监听关注与回关事件' }), null);
});

test('console phases keep failures, unknown durations and live elapsed time', () => {
  const t = 1000;
  const failed = groupConsoleSteps([
    { id: 4, sessionId: 's', worker: 'loop', name: '写入关注队列 · 帖子 2/2', status: 'failed', startedAt: t + 400, endedAt: t + 500, durationMs: 100 },
    { id: 3, sessionId: 's', worker: 'loop', name: '整理候选用户 · 帖子 2/2', status: 'completed', startedAt: t + 300, endedAt: t + 350, durationMs: 50 },
    { id: 2, sessionId: 's', worker: 'loop', name: '抓取帖子回复 · 帖子 1/2', status: 'completed', startedAt: t + 200, endedAt: t + 250, durationMs: 50 },
    { id: 1, sessionId: 's', worker: 'loop', name: '搜索博主帖子 · 帖子 1/2', status: 'completed', startedAt: t, endedAt: t + 50, durationMs: 50 },
  ], t + 500);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed');
  assert.equal(failed[0].durationMs, 250);

  const live = groupConsoleSteps([
    { id: 2, sessionId: 'f', worker: 'loop', name: '抓取帖子回复 · 帖子 1/2', status: 'running', startedAt: t + 300, endedAt: null, durationMs: null },
    { id: 1, sessionId: 'f', worker: 'loop', name: '搜索博主帖子 · 帖子 1/2', status: 'completed', startedAt: t, endedAt: t + 50, durationMs: 50 },
  ], t + 500);
  assert.equal(live.length, 1);
  assert.equal(live[0].status, 'running');
  assert.equal(live[0].endedAt, null);
  assert.equal(live[0].durationMs, 250, '进行中的阶段按当前时间补足已用时长');

  const interrupted = groupConsoleSteps([
    { id: 1, sessionId: 'i', worker: 'loop', name: '抓取粉丝（200 人） · 粉丝', status: 'interrupted', startedAt: t, endedAt: null, durationMs: null },
  ], t + 500);
  assert.equal(interrupted[0].status, 'interrupted');
  assert.equal(interrupted[0].durationMs, null, '中断步骤不推算耗时');
});
