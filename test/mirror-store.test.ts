/** 验证镜像监控配置与每帖处理结果的持久化去重。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorStore } from "../src/mirror-store.ts";

test("registers, lists and removes watches with a persisted watermark", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-mirror-store-"));
  try {
    const store = new MirrorStore(join(dir, "mirror.sqlite"));
    store.registerWatch({ targetUsername: "Target", targetId: "111", posterId: "1" });
    assert.equal(store.getWatch("target")!.posterId, "1");
    assert.equal(store.getWatch("target")!.sinceId, null);

    store.setSinceId("target", "900");
    assert.equal(store.getWatch("TARGET")!.sinceId, "900");
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
