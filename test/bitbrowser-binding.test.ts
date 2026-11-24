import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBitBinding, getBitBinding, markBitAuthorized } from '../scripts/browser/bitbrowser-binding.ts';

test('账号可使用相同首选窗口，运行时以租约保证互斥', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bit-binding-'));
  try {
    assert.equal(await getBitBinding('1', root), null);
    const data = { version: 1, accounts: { '1': { windowId: 'abc', apiUrl: 'http://127.0.0.1:54345' } } };
    await writeFile(join(root, 'bitbrowser-bindings.json'), JSON.stringify(data));
    assert.deepEqual(await getBitBinding('1', root), data.accounts['1']);
    assert.equal(await getBitBinding('2', root), null);
    (data.accounts as any)['2'] = data.accounts['1'];
    await writeFile(join(root, 'bitbrowser-bindings.json'), JSON.stringify(data));
    assert.deepEqual(await getBitBinding('1', root), data.accounts['1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('并发首次启动为账号保留不同窗口，重启沿用绑定，授权状态持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bit-allocate-'));
  try {
    const cookie = join(root, 'cookie.txt'); await writeFile(cookie, 'test');
    await writeFile(join(root, 'bitbrowser-pool.json'), JSON.stringify({ version: 1, origin: 'http://127.0.0.1:54345', slots: [
      { number: 1, id: 'first', verified: true }, { number: 2, id: 'second', verified: true },
    ] }));
    const [a, b] = await Promise.all([ensureBitBinding('1', root, cookie), ensureBitBinding('2', root, cookie)]);
    assert.notEqual(a.windowId, b.windowId);
    assert.equal((await ensureBitBinding('1', root)).windowId, a.windowId);
    assert.equal(a.needsAuthorization, true);
    await markBitAuthorized('1', a, root);
    assert.equal((await getBitBinding('1', root))?.needsAuthorization, undefined);
    assert.equal((await ensureBitBinding('3', root, cookie)).windowId, 'first');
  } finally { await rm(root, { recursive: true, force: true }); }
});
