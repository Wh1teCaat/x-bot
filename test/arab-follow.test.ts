/** 验证备用粉丝关注的筛选边界的行为与边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { followFirstArabFollower } from "../src/arab-follow.ts";

test("selects the highest ranked blogger and follows exactly one returned follower", async () => {
  const calls: string[] = [];
  const result = await followFirstArabFollower("1", {
    knownStatus: () => undefined,
    search: async () => { calls.push("search"); return { data: [
      { id: "10", public_metrics: { followers_count: 10000 } },
      { id: "20", description: "مرحبا", public_metrics: { followers_count: 1 } },
    ] }; },
    followers: async (id) => { calls.push(`followers:${id}`); return { data: [{ id: "30", connection_status: [] }] }; },
    follow: async (id) => { calls.push(`follow:${id}`); return { data: { following: true } }; },
  });
  assert.deepEqual(calls, ["search", "followers:20", "follow:30"]);
  assert.equal(result.status, "follow_requested");
  assert.equal(result.blogger?.id, "20");
});

test("skips already followed and pending accounts across pages", async () => {
  const tokens: (string | undefined)[] = [];
  const followed: string[] = [];
  const result = await followFirstArabFollower("1", {
    knownStatus: () => undefined,
    search: async () => ({ data: [{ id: "20" }] }),
    followers: async (_id, token) => {
      tokens.push(token);
      if (!token) return { data: [{ id: "30", connection_status: ["following"] }], meta: { next_token: "next1" } };
      if (token === "next1") return { data: [{ id: "31", connection_status: ["follow_request_sent"] }], meta: { next_token: "next2" } };
      return { data: [{ id: "32", connection_status: ["followed_by"] }] };
    },
    follow: async (id) => { followed.push(id); return { data: { following: true } }; },
  });
  assert.deepEqual(tokens, [undefined, "next1", "next2"]);
  assert.deepEqual(followed, ["32"]);
  assert.equal(result.skipped, 2);
});

test("does not follow if relationship status is malformed or pagination repeats", async () => {
  for (const scenario of ["malformed", "repeated"]) {
    let followed = false;
    const result = await followFirstArabFollower("1", {
      knownStatus: () => undefined,
    search: async () => ({ data: [{ id: "20" }] }),
      followers: async () => scenario === "malformed"
        ? { data: [{ id: "30", connection_status: "invalid" as any }] }
        : { data: [{ id: "30", connection_status: ["following"] }], meta: { next_token: "same" } },
      follow: async () => { followed = true; return {}; },
    });
    assert.equal(result.status, "incomplete");
    assert.equal(followed, false);
  }
});

test("stops before following when results are empty, incomplete or self", async () => {
  for (const scenario of ["empty_search", "partial_search", "empty_followers", "partial_followers", "self"]) {
    let followed = false;
    const result = await followFirstArabFollower("1", {
      knownStatus: () => undefined,
    search: async () => scenario === "empty_search" ? { data: [] } : scenario === "partial_search" ? { data: [{ id: "20" }], errors: [{}] } : { data: [{ id: "20" }] },
      followers: async () => scenario === "empty_followers" ? { data: [] } : scenario === "partial_followers" ? { data: [{ id: "30" }], errors: [{}] } : { data: [{ id: "1" }] },
      follow: async () => { followed = true; return {}; },
    });
    assert.notEqual(result.status, "follow_requested", scenario);
    assert.equal(followed, false, scenario);
  }
});
