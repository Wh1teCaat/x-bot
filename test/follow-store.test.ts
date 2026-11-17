/** 验证关注关系存储和同步的行为与边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FollowStore, syncFollowing } from "../src/follow-store.ts";

test("syncs every page atomically and isolates accounts and pending requests", async () => {
  const store = new FollowStore(":memory:");
  try {
    store.record("1", "old", "following");
    store.record("1", "pending", "pending");
    store.record("2", "10", "following");
    const summary = await syncFollowing(store, "1", async (token) => token
      ? { data: [{ id: "20" }], meta: { result_count: 1 } }
      : { data: [{ id: "10" }], meta: { result_count: 1, next_token: "next" } });
    assert.deepEqual(summary, { pages: 2, count: 2 });
    assert.equal(store.status("1", "old"), undefined);
    assert.equal(store.status("1", "10"), "following");
    assert.equal(store.status("1", "20"), "following");
    assert.equal(store.status("1", "pending"), "pending");
    assert.equal(store.status("2", "10"), "following");
    assert.equal(store.status("2", "20"), undefined);
    await assert.rejects(syncFollowing(store, "1", async (token) => token
      ? { errors: [{}], meta: { result_count: 0 } }
      : { data: [{ id: "30" }], meta: { next_token: "next" } }));
    assert.equal(store.status("1", "10"), "following");
    assert.equal(store.status("1", "30"), undefined);
  } finally { store.close(); }
});

test("updates pending status when following sync confirms it", async () => {
  const store = new FollowStore(":memory:");
  try {
    store.record("1", "30", "pending");
    await syncFollowing(store, "1", async () => ({ data: [{ id: "30" }], meta: { result_count: 1 } }));
    assert.equal(store.status("1", "30"), "following");
  } finally { store.close(); }
});

test('persists incoming follows idempotently and checks the correct account', () => {
  const store = new FollowStore(':memory:');
  try {
    store.record('1', '3', 'following');
    store.record('2', '3', 'pending');
    assert.equal(store.recordInboundFollow('event-1', '1', '3'), '互关');
    assert.equal(store.recordInboundFollow('event-1', '1', '3'), '重复事件');
    assert.equal(store.recordInboundFollow('event-2', '2', '3'), '已关注我，是否互关待确认');
    assert.equal(store.hasObservedMutualFollow('1', '3'), true);
    assert.equal(store.hasObservedMutualFollow('2', '3'), false);
    store.record('2', '3', 'following');
    assert.equal(store.hasObservedMutualFollow('2', '3'), true);
  } finally { store.close(); }
});

test('reserves attempts atomically within a rolling 24-hour account limit', () => {
  const store = new FollowStore(':memory:');
  try {
    const now = 200000000;
    assert.equal(store.reserveWithDailyLimit('1', '2', 2, now), 'reserved');
    assert.equal(store.reserveWithDailyLimit('1', '2', 2, now), 'duplicate');
    assert.equal(store.reserveWithDailyLimit('1', '3', 2, now), 'reserved');
    assert.equal(store.reserveWithDailyLimit('1', '4', 2, now), 'limit');
    assert.equal(store.reserveWithDailyLimit('5', '4', 2, now), 'reserved');
    assert.equal(store.reserveWithDailyLimit('1', '4', 2, now + 86400000), 'reserved');
  } finally { store.close(); }
});
