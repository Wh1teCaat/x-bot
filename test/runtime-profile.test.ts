import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntimeProfile } from '../scripts/browser/runtime-profile.ts';

test('账号历史从旧资料迁移到独立目录，临时浏览器关闭后保存并恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-runtime-'));
  const idb = 'Default/IndexedDB/chrome-extension_ebcejikneofoobengkjlojmbohgjacne_0.indexeddb.leveldb';
  try {
    const legacy = join(root, 'chromium-profiles/123-follow', idb);
    await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'history'), 'old');
    await writeFile(join(root, 'chromium-profiles/123-follow/Default/Preferences'), 'private profile');
    const first = await prepareRuntimeProfile('123', '-follow', root);
    assert.equal(await readFile(join(first.path, idb, 'history'), 'utf8'), 'old');
    await assert.rejects(readFile(join(first.path, 'Default/Preferences')), /ENOENT/);
    await writeFile(join(first.path, idb, 'history'), 'new');
    await first.saveAndRemove();
    assert.equal(await readFile(join(legacy, 'history'), 'utf8'), 'old');
    const second = await prepareRuntimeProfile('123', '-follow', root);
    assert.equal(await readFile(join(second.path, idb, 'history'), 'utf8'), 'new');
    await writeFile(join(second.path, idb, 'history'), 'crash');
    const recovered = await prepareRuntimeProfile('123', '-follow', root);
    assert.equal(await readFile(join(recovered.path, idb, 'history'), 'utf8'), 'crash');
    await recovered.saveAndRemove();
    const other = await prepareRuntimeProfile('456', '-follow', root);
    await assert.rejects(readFile(join(other.path, idb, 'history')), /ENOENT/);
    await symlink('host-123', join(other.path, 'SingletonLock'));
    await assert.rejects(other.saveAndRemove(), /SingletonLock/);
    assert.equal(await readFile(join(root, 'account-data/123/exporter-follow', 'chrome-extension_ebcejikneofoobengkjlojmbohgjacne_0.indexeddb.leveldb/history'), 'utf8'), 'crash');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the allocated slot permission files are copied to the runtime profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-slot-permissions-'));
  try {
    const template = join(root, 'browser-permission-slots/2/Default');
    await mkdir(template, { recursive: true });
    await writeFile(join(template, 'Preferences'), 'permissions');
    await writeFile(join(template, 'Cookies'), 'secret from template');
    const instance = await prepareRuntimeProfile('123', '', root, 2);
    assert.equal(await readFile(join(instance.path, 'Default/Preferences'), 'utf8'), 'permissions');
    await assert.rejects(readFile(join(instance.path, 'Default/Cookies')), /ENOENT/);
    await instance.saveAndRemove();
    const other = await prepareRuntimeProfile('123', '', root, 1);
    await assert.rejects(readFile(join(other.path, 'Default/Preferences')), /ENOENT/);
    await other.saveAndRemove();
  } finally { await rm(root, { recursive: true, force: true }); }
});
