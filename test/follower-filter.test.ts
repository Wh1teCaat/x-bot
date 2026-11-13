/** 验证固定关注/粉丝平衡规则及其分组边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followerBalance,
  qualifyByFollowerBalance,
} from "../scripts/replies/follower-filter.ts";

test("requires both counts above 50 and a ratio no greater than two", () => {
  assert.equal(followerBalance({ followers_count: 51, following_count: 51 }).eligible, true);
  assert.equal(followerBalance({ followers_count: 100, following_count: 200 }).eligible, true);
  assert.equal(followerBalance({ followers_count: 200, following_count: 100 }).eligible, true);
  assert.equal(followerBalance({ followers_count: 50, following_count: 200 }).eligible, false);
  assert.equal(followerBalance({ followers_count: 51, following_count: 50 }).eligible, false);
  assert.equal(followerBalance({ followers_count: 100, following_count: 201 }).eligible, false);
  assert.equal(followerBalance({}).eligible, false);
  assert.equal(followerBalance({ followers_count: "100", following_count: 100 }).eligible, false);
  assert.equal(followerBalance(null).reason, "缺少关注数或粉丝数");
});

test("separates qualified and rejected CSV candidates in order", () => {
  const result = qualifyByFollowerBalance([
    { username: "a", replies: ["hello"], followers: 51, following: 102 },
    { username: "b", followers: 50, following: 50 },
    { username: "c", followers: 300, following: 100 },
    { username: "d" },
  ]);
  assert.deepEqual(result.qualified, [
    { username: "a", replies: ["hello"], followers: 51, following: 102 },
  ]);
  assert.deepEqual(result.rejected.map((item) => item.username), ["b", "c", "d"]);
  assert.match(result.rejected[0].reason!, /大于 50/);
  assert.match(result.rejected[1].reason!, /相差超过 2 倍/);
  assert.match(result.rejected[2].reason!, /缺少关注数或粉丝数/);
});
