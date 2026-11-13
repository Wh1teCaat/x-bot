/** 验证镜像同步的复制文本与图片、去重、失败重试与跳过逻辑。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorStore } from "../src/mirror-store.ts";
import { mirrorNewPosts, mirrorTweet, normalizeText } from "../scripts/mirror/mirror-core.ts";

test("normalizes and truncates copied text", () => {
  assert.equal(normalizeText("  hello world  "), "hello world");
  assert.equal(normalizeText("x".repeat(300)).length, 280);
  assert.equal(normalizeText(null), "");
});

test("posts text and images once and skips already processed and empty ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-core-"));
  const store = new MirrorStore(join(dir, "mirror.sqlite"));
  try {
    const posted: { text: string; mediaIds: string[] }[] = [];
    const uploaded: string[] = [];
    const watch = { targetUsername: "Target", targetId: "111", posterId: "p1", sinceId: "5", enabled: true };
    const client = {
      fetchTimeline: async () => ({
        tweets: [
          { id: "10", text: "new post", images: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.png"] },
          { id: "9", text: "   ", images: [] },
          { id: "8", text: "already done", images: [] },
        ],
        newestId: "10",
      }),
      uploadImage: async (url) => { uploaded.push(url); return { media_id: "m" + uploaded.length }; },
      postTweet: async (text, mediaIds) => { posted.push({ text, mediaIds }); return { id: "p" + text }; },
    };
    store.recordPost("111", "8", "p1", "posted");
    const result = await mirrorNewPosts({ store, watch, client });
    assert.deepEqual(posted, [{ text: "new post", mediaIds: ["m1", "m2"] }]);
    assert.deepEqual(uploaded, ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.png"]);
    assert.equal(result.posted, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.newestId, "10");

    const again = await mirrorNewPosts({ store, watch, client });
    assert.equal(again.posted, 0);
    assert.equal(again.skipped, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limit mirrors only the newest N posts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-core-"));
  const store = new MirrorStore(join(dir, "mirror.sqlite"));
  try {
    const posted: string[] = [];
    const watch = { targetUsername: "Target", targetId: "111", posterId: "p1", sinceId: null, enabled: true };
    const client = {
      fetchTimeline: async () => ({
        tweets: [
          { id: "10", text: "a", images: [] },
          { id: "9", text: "b", images: [] },
          { id: "8", text: "c", images: [] },
          { id: "7", text: "d", images: [] },
        ],
        newestId: "10",
      }),
      uploadImage: async () => { throw new Error("unused"); },
      postTweet: async (text) => { posted.push(text); return { id: text }; },
    };
    const result = await mirrorNewPosts({ store, watch, client, limit: 3 });
    assert.deepEqual(posted, ["a", "b", "c"]);
    assert.equal(result.posted, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gives up after three failures and stops the tick on a fresh failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-core-"));
  const store = new MirrorStore(join(dir, "mirror.sqlite"));
  try {
    const watch = { targetUsername: "Target", targetId: "111", posterId: "p1", sinceId: null, enabled: true };
    const client = {
      fetchTimeline: async () => ({ tweets: [{ id: "1", text: "x", images: [] }], newestId: "1" }),
      uploadImage: async () => { throw new Error("unused"); },
      postTweet: async () => { throw new Error("boom"); },
    };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => mirrorNewPosts({ store, watch, client }));
    }
    let calls = 0;
    const client2 = {
      fetchTimeline: async () => ({ tweets: [{ id: "1", text: "x", images: [] }], newestId: "1" }),
      uploadImage: async () => { throw new Error("unused"); },
      postTweet: async () => { calls++; return { id: "p" }; },
    };
    const result = await mirrorNewPosts({ store, watch, client: client2 });
    assert.equal(calls, 0);
    assert.equal(result.skipped, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirrorTweet posts text even without images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-core-"));
  const store = new MirrorStore(join(dir, "mirror.sqlite"));
  try {
    const watch = { targetUsername: "Target", targetId: "111", posterId: "p1", sinceId: null, enabled: true };
    let mediaIds: string[] = [];
    const outcome = await mirrorTweet({
      store, watch, tweet: { id: "1", text: "hi", images: [] },
      postTweet: async (text, ids) => { mediaIds = ids; return { id: "p" }; },
      uploadImage: async () => { throw new Error("unused"); },
    });
    assert.equal(outcome, "posted");
    assert.deepEqual(mediaIds, []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
