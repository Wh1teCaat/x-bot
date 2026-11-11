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
