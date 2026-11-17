import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FollowOutbox } from '../src/follow-outbox.ts';

test('deduplicates by account and target, limits each batch and survives interruption', () => {
  const q = new FollowOutbox(':memory:');
  try {
    const entries = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), username: `u${i}`, source: 'replies' }));
    assert.equal(q.enqueue('1', entries), 25);
    assert.equal(q.enqueue('1', [{ ...entries[0], source: 'followers' }]), 0);
    assert.equal(q.enqueue('2', [entries[0]]), 1);
    const batch = q.pending('1'); assert.equal(batch.length, 20);
    assert.equal(q.begin('1', batch[0].target_id), true);
    assert.equal(q.begin('1', batch[0].target_id), false);
    q.recover('1');
    assert.equal(q.db.prepare('SELECT status FROM follow_outbox WHERE account_id=? AND target_id=?').get('1', batch[0].target_id).status, 'manual');
    assert.equal(q.pending('1').length, 20);
    q.schedule('1', 12345); assert.equal(q.nextBatch('1'), 12345); assert.equal(q.nextBatch('2'), 0);
  } finally { q.close(); }
});
