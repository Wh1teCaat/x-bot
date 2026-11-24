import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIdFromKey, findExtensionPackage } from '../scripts/browser/extension-packages.ts';

test('finds an extension only when its public key matches the expected ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-extension-pack-'));
  try {
    const key = Buffer.from('extension key').toString('base64');
    const id = extensionIdFromKey(key)!;
    const path = join(root, 'Default/Extensions', id, '1.0');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ key }));
    assert.equal(await findExtensionPackage(root, id), path);
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ key: Buffer.from('other key').toString('base64') }));
    assert.equal(await findExtensionPackage(root, id), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
