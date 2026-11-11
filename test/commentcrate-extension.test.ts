/** 验证插件目录校验和缺省情况不修改站点权限。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesCommentCrateKey, resolveCommentCratePath } from '../scripts/commentcrate-extension.ts';

test('rejects a different extension and permits a missing default installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-extension-test-'));
  try {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ key: Buffer.from('not-commentcrate').toString('base64') }));
    assert.equal(matchesCommentCrateKey(''), false);
    await assert.rejects(resolveCommentCratePath(dir), /不是预期/);
    assert.equal(await resolveCommentCratePath(undefined, dir), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
