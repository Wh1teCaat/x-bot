import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowStore } from '../src/follow-store.ts';
import { FollowOutbox } from '../src/follow-outbox.ts';
import { queueInboundFollow, completedInboundFollows } from '../scripts/follow/inbound-follow.ts';

test('inbound follow is queued once and becomes eligible for welcome only after confirmed follow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbound-follow-'));
  const path = join(dir, 'following.sqlite');
  try {
    const event = { eventId: 'e1', accountId: '1', followerId: '2', followerUsername: 'alice' };
    assert.equal(queueInboundFollow(event, path).queued, true);
    queueInboundFollow(event, path);
    let box = new FollowOutbox(path);
    assert.equal(box.pending('1').length, 1);
    assert.equal(box.begin('1', '2'), true);
    box.finish('1', '2', 'done'); box.close();
    assert.equal(completedInboundFollows(path).length, 0);
    const store = new FollowStore(path);
    store.record('1', '2', 'pending');
    assert.equal(completedInboundFollows(path).length, 0);
    store.record('1', '2', 'following'); store.close();
    assert.deepEqual(completedInboundFollows(path).map(item => [item.account_id, item.target_id]), [['1', '2']]);
    assert.equal(queueInboundFollow({ ...event, eventId: 'e2' }, path).status, 'following');
    box = new FollowOutbox(path); assert.equal(box.pending('1').length, 0); box.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pending and uncertain follow states are never re-enqueued', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbound-follow-'));
  const path = join(dir, 'following.sqlite');
  try {
    const store = new FollowStore(path); store.record('1', '2', 'pending'); store.record('1', '3', 'uncertain'); store.close();
    for (const id of ['2', '3']) assert.equal(queueInboundFollow({ eventId: `e${id}`, accountId: '1', followerId: id, followerUsername: '' }, path).queued, false);
    const box = new FollowOutbox(path); assert.equal(box.pending('1').length, 0); box.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
