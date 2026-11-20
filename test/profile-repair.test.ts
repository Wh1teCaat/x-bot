import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountStore } from '../src/account-store.ts';

const script = resolve('scripts/browser/repair-profile.ts');
test('repair preserves old profile and requires a new login check', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-profile-repair-'));
  try {
    const profiles = join(root, '.data', 'browser-profiles');
    const profile = join(profiles, '12345');
    const template = join(root, '.data', 'profile-template');
    const extension = join(template, 'Default', 'Extensions', 'haaahmifcccbgagmopbhbkgabgblmcbl');
    await mkdir(extension, { recursive: true });
    await mkdir(profile, { recursive: true });
    for (const file of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']) await writeFile(join(template, file), '{}');
    await writeFile(join(extension, 'manifest.json'), '{}');
    await writeFile(join(profile, 'old-login'), 'preserved');
    const store = new AccountStore(join(root, '.data'));
    store.upsert({ uuid: '12345', username: 'example', chromeReady: true }); store.close();
    await writeFile(join(profiles, '12345.lock'), '1');
    const blocked = spawnSync(process.execPath, [script, '12345'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.equal(await readFile(join(profile, 'old-login'), 'utf8'), 'preserved');
    await rm(join(profiles, '12345.lock'));
    execFileSync(process.execPath, [script, '12345'], { cwd: root });
    const backup = (await readdir(profiles)).find(name => name.startsWith('12345.backup-'));
    assert.ok(backup);
    assert.equal(await readFile(join(profiles, backup, 'old-login'), 'utf8'), 'preserved');
    assert.equal(await readFile(join(profile, 'Default', 'Extensions', 'haaahmifcccbgagmopbhbkgabgblmcbl', 'manifest.json'), 'utf8'), '{}');
    const updated = new AccountStore(join(root, '.data'));
    assert.equal(updated.getByUuid('12345')?.chromeReady, false); updated.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
