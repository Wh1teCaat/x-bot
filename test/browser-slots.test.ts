import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireBrowserSlot } from '../scripts/browser/browser-slots.ts';

test('enforces capacity, waits for release, and recovers stale slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-slots-'));
  const path = join(dir, 'slots.sqlite');
  try {
    const a = await acquireBrowserSlot('a', { path, limit: 2 });
    const b = await acquireBrowserSlot('b', { path, limit: 2 });
    let waiting = false, acquired = false;
    const next = acquireBrowserSlot('c', { path, limit: 2, pollMs: 5, onWait: () => { waiting = true; } }).then(release => { acquired = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(waiting, true); assert.equal(acquired, false);
    a(); const c = await next;
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('SELECT count(*) AS n FROM browser_slots').get() as any).n, 2);
    b(); c();
    db.prepare('INSERT INTO browser_slots VALUES(1,?,?,?)').run(99999999, 'stale', 'old');
    const d = await acquireBrowserSlot('d', { path, limit: 2 });
    assert.equal((db.prepare('SELECT account FROM browser_slots WHERE slot=1').get() as any).account, 'd');
    d(); db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
