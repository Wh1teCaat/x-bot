/** 验证插件模板只复制扩展相关文件，并为账号资料隔离复制。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileTemplate, ensureProfileFromChrome, ensureProfileFromTemplate } from '../scripts/browser/profile-template.ts';

async function makeSource(dir: string, withExtensions = true) {
  await mkdir(join(dir, 'Default'), { recursive: true });
  await writeFile(join(dir, 'Local State'), '{}');
  await writeFile(join(dir, 'Default', 'Preferences'), '{}');
  await writeFile(join(dir, 'Default', 'Secure Preferences'), '{}');
  await mkdir(join(dir, 'Default', 'Network'), { recursive: true });
  await writeFile(join(dir, 'Default', 'Network', 'Cookies'), 'cookie-data');
  await writeFile(join(dir, 'Default', 'History'), 'history');
  if (withExtensions) {
    await mkdir(join(dir, 'Default', 'Extensions', 'ext1', '1.0'), { recursive: true });
    await writeFile(join(dir, 'Default', 'Extensions', 'ext1', '1.0', 'manifest.json'), '{}');
    await mkdir(join(dir, 'Default', 'Local Extension Settings', 'ext1'), { recursive: true });
    await writeFile(join(dir, 'Default', 'Local Extension Settings', 'ext1', 'state'), 'state');
  }
}

test('creates a plugin-only template without cookies or history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-template-'));
  try {
    const source = join(root, 'source');
    const template = join(root, 'template');
    await makeSource(source);
    await createProfileTemplate(source, template);
    assert.equal(existsSync(join(template, 'Local State')), true);
    assert.equal(existsSync(join(template, 'Default', 'Extensions', 'ext1', '1.0', 'manifest.json')), true);
    assert.equal(existsSync(join(template, 'Default', 'Local Extension Settings', 'ext1', 'state')), true);
    assert.equal(existsSync(join(template, 'Default', 'Network', 'Cookies')), false);
    assert.equal(existsSync(join(template, 'Default', 'History')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('copies the template only into a missing or empty profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-template-'));
  try {
    const source = join(root, 'source');
    const template = join(root, 'template');
    const profile = join(root, 'profile');
    await makeSource(source);
    await createProfileTemplate(source, template);
    assert.equal(await ensureProfileFromTemplate(profile, template), true);
    assert.equal(existsSync(join(profile, 'Default', 'Extensions', 'ext1', '1.0', 'manifest.json')), true);
    assert.equal(await ensureProfileFromTemplate(profile, template), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a source without extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-template-'));
  try {
    const source = join(root, 'source');
    await makeSource(source, false);
    await assert.rejects(createProfileTemplate(source, join(root, 'template')), /Default\/Extensions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repairs a missing plugin from Chrome without replacing cookies or extension storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-chrome-copy-'));
  try {
    const source = join(root, 'source'), profile = join(root, 'account');
    await makeSource(source);
    const id = 'haaahmifcccbgagmopbhbkgabgblmcbl';
    await mkdir(join(source, 'Default/Extensions', id, '1.0'), { recursive: true });
    await writeFile(join(source, 'Default/Extensions', id, '1.0/manifest.json'), '{}');
    await writeFile(join(source, 'Default/Secure Preferences'), JSON.stringify({ extensions: { settings: { [id]: { path: `${id}/1.0`, disable_reasons: [] } } } }));
    await makeSource(profile);
    assert.equal(await ensureProfileFromChrome(profile, source), 'repaired');
    assert.equal(await readFile(join(profile, 'Default/Network/Cookies'), 'utf8'), 'cookie-data');
    assert.equal(await readFile(join(profile, 'Default/Local Extension Settings/ext1/state'), 'utf8'), 'state');
    assert.equal(await ensureProfileFromChrome(profile, source), null);
    assert.equal((await readdir(root)).some(name => name.startsWith('account.extensions-backup-')), true);
    const fresh = join(root, 'fresh');
    assert.equal(await ensureProfileFromChrome(fresh, source), 'created');
    assert.equal(existsSync(join(fresh, 'Default/Network/Cookies')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
