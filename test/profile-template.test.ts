/** 验证插件模板只复制扩展相关文件，并为账号资料隔离复制。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileTemplate, ensureProfileFromTemplate } from '../scripts/browser/profile-template.ts';

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
