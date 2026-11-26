import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireBrowserSlot } from '../scripts/browser/browser-slots.ts';
import { acquireCollectionSlots } from '../scripts/loop/collection-slots.ts';
import { parseLoopArguments } from '../scripts/loop/loop-arguments.ts';

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

test('overlapping post runs wait while the follower lane can still run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-collection-slots-'));
  const acquire = (flags: string[], onWait = (_lane: string) => {}) =>
    acquireCollectionSlots(parseLoopArguments(flags), onWait, undefined, dir);
  try {
    const first = await acquire(['--account-id', '1', '--no-followers']);
    let notifyWait: (lane: string) => void;
    const waiting = new Promise<string>(resolve => { notifyWait = resolve; });
    const second = acquire(['--account-id', '2', '--no-followers'], notifyWait!);
    assert.equal(await waiting, '帖子');
    const followers = await acquire(['--account-id', '3', '--followers-only']);
    first();
    const arrived = await second;
    arrived(); followers();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
