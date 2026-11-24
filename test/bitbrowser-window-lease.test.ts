import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBitWindow } from '../scripts/browser/bitbrowser-window-lease.ts';

test('优先租原窗口，原窗口忙时换空闲窗口，释放后可复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bit-lease-'));
  const api = 'http://127.0.0.1:54345';
  try {
    await writeFile(join(root, 'bitbrowser-pool.json'), JSON.stringify({ version: 1, origin: api, slots: [{ number: 1, id: 'one', verified: true }, { number: 2, id: 'two', verified: true }] }));
    const opts = { root, isOpen: async () => false, pollMs: 10 };
    const first = await acquireBitWindow('1', 'one', api, opts);
    const second = await acquireBitWindow('2', 'one', api, opts);
    assert.equal(first.windowId, 'one'); assert.equal(second.windowId, 'two');
    await first.release();
    const third = await acquireBitWindow('3', 'one', api, opts);
    assert.equal(third.windowId, 'one');
    await third.release(); await second.release();
    const fourth = await acquireBitWindow('4', 'one', api, { ...opts, isOpen: async id => id === 'one' });
    assert.equal(fourth.windowId, 'two'); await fourth.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
