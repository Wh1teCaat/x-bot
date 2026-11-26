/** 验证镜像监控配置与每帖处理结果的持久化去重。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MirrorStore } from "../src/mirror-store.ts";

test("registers, lists and removes watches with a persisted watermark", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-store-"));
  try {
    const store = new MirrorStore(join(dir, "mirror.sqlite"));
    store.registerWatch({ targetUsername: "Target", targetId: "111", posterId: "1" });
    assert.equal(store.getWatch("1", "111")!.posterId, "1");
    assert.equal(store.getWatch("1", "111")!.sinceId, null);

    store.setSinceId("1", "111", "900");
    assert.equal(store.getWatch("1", "111")!.sinceId, "900");
    assert.equal(store.listWatches().length, 1);

    store.removeWatch("target");
    assert.equal(store.listWatches().length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records post results and counts failed attempts", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-store-"));
  try {
    const store = new MirrorStore(join(dir, "mirror.sqlite"));
    assert.equal(store.postStatus("111", "1", "p1"), undefined);
    store.recordPost("111", "1", "p1", "failed");
    assert.deepEqual(store.postStatus("111", "1", "p1"), { status: "failed", attempts: 1 });
    store.recordPost("111", "1", "p1", "failed");
    assert.equal(store.postStatus("111", "1", "p1")!.attempts, 2);
    store.recordPost("111", "1", "p1", "posted");
    assert.deepEqual(store.postStatus("111", "1", "p1"), { status: "posted", attempts: 0 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueues, claims and finishes delayed reply jobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-store-"));
  try {
    const store = new MirrorStore(join(dir, "mirror.sqlite"));
    store.enqueueReplyJob({ targetId: "111", tweetId: "10", posterId: "p1", targetUsername: "target", postUrl: "https://x.com/target/status/10", dueAt: 1000 });
    store.enqueueReplyJob({ targetId: "111", tweetId: "20", posterId: "p2", targetUsername: "target", postUrl: "https://x.com/target/status/20", dueAt: 1000 });
    assert.equal(store.dueReplyJobs(999).length, 0);
    const [job] = store.dueReplyJobs(1000, 1, 'p1');
    assert.equal(job.posterId, 'p1');
    assert.equal(store.claimReplyJob(job, 1000), true);
    assert.equal(store.dueReplyJobs(1000, 1, 'p1').length, 0);
    assert.equal(store.dueReplyJobs(1000, 1, 'p2')[0].tweetId, '20');
    assert.equal(store.finishReplyJob(job, "failed", "boom", 2000), true);
    assert.equal(store.claimReplyJob(job, 1999), false);
    assert.equal(store.dueReplyJobs(1999, 1, 'p1').length, 0);
    const [retry] = store.dueReplyJobs(2000, 1, 'p1');
    assert.equal(retry.attempts, 1);
    assert.equal(store.claimReplyJob(job, 2000), false);
    assert.equal(store.claimReplyJob(retry, 2000), true);
    assert.equal(store.finishReplyJob(job, "done", null), false);
    assert.equal(store.finishReplyJob(retry, "done", null), true);
    assert.equal(store.dueReplyJobs(99999, 1, 'p1').length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates the old watermark and gives a second poster of the same target an independent watch", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-migration-"));
  try {
    const path = join(dir, "mirror.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE mirror_watches (
      target_username TEXT PRIMARY KEY, target_id TEXT, poster_id TEXT NOT NULL, since_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    INSERT INTO mirror_watches VALUES ('Target','111','p1','99',1,'2026-01-01');`);
    legacy.close();
    const store = new MirrorStore(path);
    store.registerWatch({ targetUsername: "target", targetId: "111", posterId: "p2" });
    assert.equal(store.getWatch("p1", "111")?.sinceId, "99");
    assert.equal(store.getWatch("p2", "111")?.sinceId, null);
    store.setSinceId("p2", "111", "1000");
    store.setSinceId("p1", "111", "90");
    assert.equal(store.getWatch("p1", "111")?.sinceId, "99");
    assert.equal(store.getWatch("p2", "111")?.sinceId, "1000");
    store.registerWatch({ targetUsername: "Renamed", targetId: "111", posterId: "p1" });
    store.registerWatch({ targetUsername: "target", targetId: "222", posterId: "p1" });
    assert.equal(store.getWatch("p1", "111")?.targetUsername, "Renamed");
    assert.equal(store.getWatch("p1", "111")?.sinceId, "99");
    assert.equal(store.getWatch("p1", "222")?.sinceId, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
