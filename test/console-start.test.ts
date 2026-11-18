import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAllConsoleLoops } from '../src/console-start.ts';

test('batch skips unauthorized and running accounts and continues after a failure', async () => {
  const called: string[] = [];
  const results = await startAllConsoleLoops([
    { uuid: '1', authenticated: false },
    ...['2', '3', '4'].map(uuid => ({ uuid, authenticated: true })),
  ], async id => {
    called.push(id);
    if (id === '2') throw Object.assign(new Error('正在运行'), { status: 409 });
    if (id === '3') throw new Error('启动失败');
    return { pid: 123 };
  });
  assert.deepEqual(called, ['2', '3', '4']);
  assert.deepEqual(results.map(r => r.status), ['skipped', 'skipped', 'failed', 'started']);
  assert.equal(results[2].message, '启动失败');
  assert.deepEqual(await startAllConsoleLoops([], async () => { throw Error('unexpected'); }), []);
});
