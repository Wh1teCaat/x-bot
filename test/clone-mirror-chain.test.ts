/** 验证 clone → mirror 的完整数据链路：克隆结果能直接驱动镜像监控并复制帖子。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/account-store.ts";
import { MirrorStore } from "../src/mirror-store.ts";
import { mirrorNewPosts, mirrorTweet, type MirrorTweet } from "../scripts/mirror/mirror-core.ts";
import { createStreamParser } from "../scripts/mirror/mirror-stream.ts";

test("a clone source stays exclusive across account stores, aliases and unfinished runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-clone-targets-"));
  try {
    const accounts = new AccountStore(dir);
    const otherProcess = new AccountStore(dir);
    const child = accounts.upsert({ uuid: '1', username: 'child_one' });
    const other = accounts.upsert({ uuid: '2', username: 'child_two' });
    accounts.upsert({ username: 'legacy_child', cloned: true, copiedFromUsername: 'LegacyParent' });
    assert.equal(otherProcess.reserveCloneTarget(other.id, { id: '11', username: 'legacyparent' }), false);
    assert.equal(accounts.reserveCloneTarget(child.id, { id: '12', username: 'Parent' }), true);
    assert.equal(otherProcess.reserveCloneTarget(other.id, { id: '12', username: 'RenamedParent' }), false);
    assert.equal(otherProcess.reserveCloneTarget(other.id, { id: null, username: 'pArEnT' }), false);
    assert.deepEqual({ ...otherProcess.getCloneTarget(child.id) }, { id: '12', username: 'Parent' });
    assert.equal(accounts.reserveCloneTarget(child.id, { id: null, username: 'Parent' }), true);
    accounts.completeClone(child.id, { username: 'child_renamed', name: 'Parent' });
    assert.equal(otherProcess.getByUuid('1')?.copiedFromUuid, '12');
    assert.equal(otherProcess.getByUuid('1')?.username, 'child_renamed');
    assert.equal(otherProcess.reserveCloneTarget(other.id, { id: '13', username: 'NextParent' }), true);
    otherProcess.close();
    accounts.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clone result feeds the mirror watch, backfills and then mirrors streamed posts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x-chain-"));
  try {
    const accounts = new AccountStore(dir);
    const mirrors = new MirrorStore(join(dir, "mirror.sqlite"));

    // 1) clone 完成后的账号记录：cloned + 来源账号 + 关键词。
    accounts.upsert({
      username: "subaccount",
      cloned: true,
      copiedFromUuid: null,
      copiedFromUsername: "jjaibot",
      copiedFromName: "JJ AI Bot",
      copiedAt: new Date().toISOString(),
      keywords: ["AI", "typescript"],
    });
    const clone = accounts.getByUsername("subaccount")!;
    assert.equal(clone.cloned, true);
    assert.equal(clone.copiedFromUsername, "jjaibot");

    // 2) 镜像依据 clone 的来源用户名解析目标并注册监控。
    const targetUsername = clone.copiedFromUsername!;
    const targetId = "1111111111111111111"; // 模拟 users/by 解析结果
    mirrors.registerWatch({ targetUsername, targetId, posterId: "9999999999999999999" });
    const watch = mirrors.getWatch("9999999999999999999", targetId)!;
    assert.equal(watch.targetId, targetId);

    // 3) 回填最新 3 条（文本+图片；纯图帖也要复制），并去重。
    const allTweets = [
      { id: "30", text: "post three", images: [] },
      { id: "20", text: "post two", images: ["https://pbs.twimg.com/media/a.jpg"] },
      { id: "10", text: "", images: ["https://pbs.twimg.com/media/b.jpg"] },
      { id: "5", text: "older than 3", images: [] },
    ];
    const posted: { text: string; mediaIds: string[] }[] = [];
    const client = {
      fetchTimeline: async (_tid: string, sinceId?: string) => {
        const tweets = sinceId ? allTweets.filter((t) => BigInt(t.id) > BigInt(sinceId)) : allTweets;
        return { tweets, newestId: tweets[0]?.id ?? sinceId ?? null };
      },
      uploadImage: async (url: string) => ({ media_id: "m_" + url.split("/").pop() }),
      postTweet: async (text, mediaIds) => { posted.push({ text, mediaIds }); return { id: "p_" + text }; },
    };
    const backfill = await mirrorNewPosts({ store: mirrors, watch, client, limit: 3 });
    assert.equal(backfill.posted, 3);
    assert.deepEqual(posted.map((p) => p.text), ["", "post two", "post three"]);
    assert.deepEqual(posted[0].mediaIds, ["m_b.jpg"]);
    assert.deepEqual(posted[1].mediaIds, ["m_a.jpg"]);
    assert.deepEqual(posted[2].mediaIds, []);
    mirrors.setSinceId("9999999999999999999", targetId, backfill.newestId!);

    // 重复同步不重发（水位线之后没有新帖）。
    const again = await mirrorNewPosts({ store: mirrors, watch: mirrors.getWatch("9999999999999999999", targetId)!, client });
    assert.equal(again.posted, 0);
    assert.equal(again.skipped, 0);

    // 4) 后续监听新帖（stream）→ 复制文本+图片。
    const streamed: MirrorTweet[] = [];
    const parser = createStreamParser((t) => {
      streamed.push({ id: t.id, text: t.text, images: t.mediaKeys.length ? ["https://pbs.twimg.com/media/new.jpg"] : [] });
    });
    parser('{"id":"40","text":"live post","attachments":{"media_keys":["k1"]}}\n');
    assert.equal(streamed.length, 1);

    const outcome = await mirrorTweet({
      store: mirrors, watch: mirrors.getWatch("9999999999999999999", targetId)!, tweet: streamed[0],
      postTweet: async (text, mediaIds) => { posted.push({ text, mediaIds }); return { id: "p_live" }; },
      uploadImage: async () => ({ media_id: "m_new" }),
    });
    assert.equal(outcome, "posted");
    assert.equal(posted.at(-1)!.text, "live post");
    assert.deepEqual(posted.at(-1)!.mediaIds, ["m_new"]);

    accounts.close();
    mirrors.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
