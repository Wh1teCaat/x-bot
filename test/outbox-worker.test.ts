import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { FollowOutbox } from '../src/follow-outbox.ts';

test('worker sends queued users and preserves the queue when limited', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'follow-queue-'));
  await mkdir(join(dir, '.data'));
  const dbPath = join(dir, '.data/following.sqlite');
  const box = new FollowOutbox(dbPath);
  box.enqueue('1', [{ id: '2', username: 'one', source: 'reply' }, { id: '3', username: 'two', source: 'fans' }, { id: '4', username: 'three', source: 'fans' }]);
  box.close();
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.setHeader('Content-Type', 'application/json');
    if (calls === 1) res.end(JSON.stringify({ data: { following: true } }));
    else { res.statusCode = 429; res.end(JSON.stringify({ error: 'rate limited' })); }
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [resolve('scripts/follow/outbox-worker.ts'), '1'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const deadline = Date.now() + 8000;
    while (calls < 2 && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(calls, 2);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    const verify = new FollowOutbox(dbPath);
    try {
      const rows = verify.db.prepare('SELECT target_id,status FROM follow_outbox ORDER BY target_id').all();
      assert.deepEqual(rows.map(row => [row.target_id, row.status]), [['2', 'done'], ['3', 'queued'], ['4', 'queued']]);
      assert.ok(verify.nextBatch('1') > Date.now());
    } finally { verify.close(); }
  } finally {
    if (child.exitCode === null) { child.kill('SIGINT'); await new Promise(resolvePromise => child.once('exit', resolvePromise)); }
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    await rm(dir, { recursive: true, force: true });
  }
});
