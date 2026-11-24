import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareChromiumProfile } from '../scripts/browser/chromium-profile.ts';

test('copies each account profile including follower history without altering the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-chromium-profile-'));
  try {
    const source = join(root, 'browser-profiles/123-follow/Default/IndexedDB/history');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'chunk'), 'history');
    await writeFile(join(root, 'browser-profiles/123-follow/Default/Secure Preferences'), 'old registration');
    const target = await prepareChromiumProfile('123', '-follow', root);
    assert.equal(await readFile(join(target, 'Default/IndexedDB/history/chunk'), 'utf8'), 'history');
    await assert.rejects(readFile(join(target, 'Default/Secure Preferences')), /ENOENT/);
    await writeFile(join(target, 'Default/IndexedDB/history/chunk'), 'changed');
    assert.equal(await readFile(join(source, 'chunk'), 'utf8'), 'history');
    assert.equal(await prepareChromiumProfile('123', '-follow', root), target);
    const busy = join(root, 'browser-profiles/456');
    await mkdir(busy, { recursive: true }); await symlink('some-host-100', join(busy, 'SingletonLock'));
    await assert.rejects(prepareChromiumProfile('456', '', root), /仍有锁/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
