/** 镜像核心：拉取/接收目标新帖并复制文本与图片发帖；不依赖网络与调度，便于测试。 */
import type { MirrorStore, MirrorWatch } from '../../src/mirror-store.ts';

export type MirrorTweet = { id: string; text: string; images: string[] };

export type MirrorClient = {
  fetchTimeline: (targetId: string, sinceId?: string) => Promise<{ tweets: MirrorTweet[]; newestId: string | null }>;
  uploadImage: (url: string) => Promise<{ media_id: string }>;
  postTweet: (text: string, mediaIds: string[]) => Promise<{ id: string }>;
};

export type MirrorResult = { posted: number; skipped: number; failed: number; newestId: string | null };

/** 控制两次实际发帖之间的最小随机间隔；第一次不等待。 */
export function createPostPacer({
  minMs = 5000,
  maxMs = 10000,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = Date.now,
}: {
  minMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
} = {}) {
  const min = Number.isFinite(minMs) && minMs > 0 ? minMs : 0;
  const max = Number.isFinite(maxMs) && maxMs >= min ? maxMs : min;
  let nextAt = 0;
  return async () => {
    const current = now();
    if (nextAt > current) await sleep(nextAt - current);
    nextAt = now() + min + Math.floor(random() * (max - min + 1));
  };
}

/** 按推文 ID 比较，用于保证旧帖先发、新帖后发。 */
export function compareTweetIds(a: { id: string }, b: { id: string }): number {
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 去掉首尾空白并限制在 X 单条推文 280 字符内。 */
export function normalizeText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, 280);
}

/** 镜像单条推文：去重、复制文本与图片发帖、失败计数；发帖失败抛出以停止当前批次。 */
export async function mirrorTweet({ store, watch, tweet, postTweet, uploadImage, onPost, beforePost }: {
  store: MirrorStore; watch: MirrorWatch; tweet: MirrorTweet;
  postTweet: (text: string, mediaIds: string[]) => Promise<{ id: string }>;
  uploadImage: (url: string) => Promise<{ media_id: string }>;
  onPost?: (tweetId: string, postedId: string) => void;
  beforePost?: () => Promise<void> | void;
}): Promise<"posted" | "skipped"> {
  const existing = store.postStatus(watch.targetId!, tweet.id, watch.posterId);
  if (existing?.status === "posted" || existing?.status === "skipped") return "skipped";
  if (existing?.status === "failed" && existing.attempts >= 3) return "skipped";
  const text = normalizeText(tweet.text);
  const images = (tweet.images || []).filter((u) => typeof u === "string" && u).slice(0, 4);
  if (!text && !images.length) { store.recordPost(watch.targetId!, tweet.id, watch.posterId, "skipped"); return "skipped"; }
  if (beforePost) await beforePost();
  try {
    const mediaIds: string[] = [];
    for (const url of images) mediaIds.push((await uploadImage(url)).media_id);
    const post = await postTweet(text, mediaIds);
    store.recordPost(watch.targetId!, tweet.id, watch.posterId, "posted");
    onPost?.(tweet.id, post.id);
    return "posted";
  } catch (error) {
    store.recordPost(watch.targetId!, tweet.id, watch.posterId, "failed");
    throw error;
  }
}

/** 单次同步：读取新帖，逐条镜像；limit 限制处理的条数（用于启动回填），发帖失败抛出。 */
export async function mirrorNewPosts({ store, watch, client, onPost, limit, beforePost }: {
  store: MirrorStore; watch: MirrorWatch; client: MirrorClient; onPost?: (tweetId: string, postedId: string) => void; limit?: number;
  beforePost?: () => Promise<void> | void;
}): Promise<MirrorResult> {
  if (!watch.targetId) throw new Error(`目标账号 ${watch.targetUsername} 尚未解析数字 ID`);
  const result: MirrorResult = { posted: 0, skipped: 0, failed: 0, newestId: null };

  const fetched = await client.fetchTimeline(watch.targetId, watch.sinceId ?? undefined);
  // X 时间线默认新帖在前；回填 limit 取最新 N 条，但发布必须按旧 -> 新。
  const selected = limit != null ? fetched.tweets.slice(0, limit) : fetched.tweets;
  const ordered = [...selected].sort(compareTweetIds);
  result.newestId = fetched.newestId ?? [...fetched.tweets].sort(compareTweetIds).at(-1)?.id ?? watch.sinceId;
  if (!ordered.length) return result;

  for (const tweet of ordered) {
    try {
      const outcome = await mirrorTweet({ store, watch, tweet, postTweet: client.postTweet, uploadImage: client.uploadImage, onPost, beforePost });
      if (outcome === "posted") result.posted++; else result.skipped++;
    } catch (error) {
      result.failed++;
      throw error;
    }
  }
  return result;
}
