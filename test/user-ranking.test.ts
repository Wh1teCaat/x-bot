/** 验证候选用户排序的行为与边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankUsers } from "../src/user-ranking.ts";

test("ranks Saudi location, Arabic script and followers in that order", () => {
  const users = [
    { id: "other", public_metrics: { followers_count: 10000 } },
    { id: "arabic", description: "مرحبا", public_metrics: { followers_count: 500 } },
    { id: "country", location: "Saudi Arabia", public_metrics: { followers_count: 1 } },
    { id: "city", location: "الرياض", description: "مرحبا", public_metrics: { followers_count: 10 } },
    { id: "ksa", location: "KSA", description: "مرحبا", public_metrics: { followers_count: 2 } },
    { id: "missing", location: "沙特", description: "مرحبا" },
  ];
  const result = rankUsers(users, (user) => user);
  assert.deepEqual(result.map((user) => user.id), ["city", "ksa", "missing", "country", "arabic", "other"]);
  assert.equal(users[0].id, "other");
});

test("sorts wrapped candidates stably and does not match English substrings", () => {
  const candidates = [
    { user: { id: "a", location: "Saudiapolis" } },
    { user: { id: "b", location: "London" } },
    { user: { id: "c", location: "Jeddah" } },
  ];
  assert.deepEqual(rankUsers(candidates, (item) => item.user).map((item) => item.user.id), ["c", "a", "b"]);
});
