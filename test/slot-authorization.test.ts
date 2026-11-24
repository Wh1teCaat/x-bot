import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allSlotsAuthorized, markSlotAuthorized, slotAuthorizationReady } from '../scripts/browser/slot-authorization.ts';

test('授权标记仅在全部空位均已确认且配置未变化时生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-permission-marker-'));
  try {
    for (let i = 1; i <= 5; i++) {
      const base = join(root, 'browser-permission-slots', String(i));
      await mkdir(join(base, 'Default'), { recursive: true });
      for (const name of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']) await writeFile(join(base, name), `${i}:${name}`);
      assert.equal(await slotAuthorizationReady(i, root), false);
      await markSlotAuthorized(i, root);
    }
    assert.equal(await allSlotsAuthorized(root), true);
    await writeFile(join(root, 'browser-permission-slots/3/Default/Preferences'), 'changed');
    assert.equal(await slotAuthorizationReady(3, root), false);
    assert.equal(await allSlotsAuthorized(root), false);
    assert.equal(await slotAuthorizationReady(2, root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
