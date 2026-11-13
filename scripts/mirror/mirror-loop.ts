/** 镜像监控入口：启动先回填目标最新 3 条（文本+图片），再优先 filtered stream 实时监听，失败回退 REST 轮询。 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { MirrorStore } from '../../src/mirror-store.ts';
import { mirrorNewPosts, mirrorTweet, type MirrorClient, type MirrorTweet } from './mirror-core.ts';
import { createStreamParser, type StreamTweet } from './mirror-stream.ts';

const validHandle = (v: string) => /^[A-Za-z0-9_]{1,15}$/.test(v);
const validId = (v: string) => /^\d{1,19}$/.test(v);

const portText = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(String(portText)) || +portText < 1 || +portText > 65535) { console.error('PORT 无效'); process.exit(1); }
const origin = `http://127.0.0.1:${portText}`;

/** 仅连接本机授权服务，执行发帖、媒体与时间线请求。 */
class LocalMirrorClient {
  origin: string;
  accountId: string;
  constructor(accountId: string) { this.origin = origin; this.accountId = accountId; }

  async request(path: string, method = 'GET', body?: unknown) {
    let response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: { 'X-Local-Request': '1', ...(method === 'POST' ? { Origin: this.origin, 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
      });
    } catch { throw new Error('无法连接本地授权服务，请先运行 npm start'); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `本地服务错误 (${response.status})`) as Error & { status: number };
      error.status = response.status; throw error;
    }
    return payload;
  }

  lookup(username: string): Promise<string> {
    return this.request(`/api/accounts/${this.accountId}/users/by?${new URLSearchParams({ usernames: username })}`)
      .then((result) => {
        const user = (result.data || []).find((u: { username?: string }) => u.username?.toLowerCase() === username.toLowerCase());
        if (!user || !validId(user.id)) throw new Error(`未能解析目标用户 @${username} 的数字 ID`);
        return user.id;
      });
  }

  async fetchTimeline(targetId: string, sinceId?: string): Promise<{ tweets: MirrorTweet[]; newestId: string | null }> {
    const params = new URLSearchParams({ max_results: '100', exclude: 'retweets', 'tweet.fields': 'attachments,text', expansions: 'attachments.media_keys', 'media.fields': 'type,url,preview_image_url' });
    if (sinceId) params.set('since_id', sinceId);
    const result = await this.request(`/api/accounts/${this.accountId}/users/${targetId}/tweets?${params}`);
    const mediaByKey = new Map<string, { type?: string; url?: string }>((result.includes?.media || []).map((m: { media_key?: string }) => [m.media_key as string, m]));
    const tweets = (result.data || [])
      .filter((t: { id?: string }) => typeof t.id === 'string' && /^\d{1,19}$/.test(t.id))
      .map((t: { id: string; text?: string; attachments?: { media_keys?: string[] } }) => ({
        id: t.id,
        text: t.text ?? '',
        images: (t.attachments?.media_keys || [])
          .map((k) => mediaByKey.get(k))
          .filter((m) => m?.type === 'photo' && typeof m.url === 'string')
          .map((m) => m!.url!),
      }));
    return { tweets, newestId: typeof result.meta?.newest_id === 'string' ? result.meta.newest_id : null };
  }

  async fetchMedia(tweetId: string): Promise<string[]> {
    const result = await this.request(`/api/accounts/${this.accountId}/tweets/${tweetId}/media`);
    return (result.data?.images || []).filter((u: unknown) => typeof u === 'string');
  }

  async uploadImage(url: string): Promise<{ media_id: string }> {
    const result = await this.request(`/api/accounts/${this.accountId}/media`, 'POST', { url });
    return { media_id: result.data?.media_id };
  }

  async postTweet(text: string, mediaIds: string[]): Promise<{ id: string }> {
    const result = await this.request(`/api/accounts/${this.accountId}/tweets`, 'POST', { text, media_ids: mediaIds });
    return { id: typeof result.data?.id === 'string' ? result.data.id : '' };
  }
}

const rawArgs = process.argv.slice(2);
const once = rawArgs.includes('--once');
const forcePoll = rawArgs.includes('--poll');
const positionals = rawArgs.filter((a) => !a.startsWith('--'));
const [command, arg1, ...extra] = positionals;
const store = new MirrorStore(resolve('.data', 'mirror.sqlite'));
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

try {
  if (command === 'list') {
    for (const w of store.listWatches()) console.log(`@${w.targetUsername} -> 发帖账号 ${w.posterId}，已启用=${w.enabled}，水位 ${w.sinceId ?? '（无）'}`);
    process.exit(0);
  }
  if (command === 'remove') {
    if (!arg1 || !validHandle(arg1) || extra.length) throw new Error('用法：npm run mirror -- remove <目标用户名>');
    store.removeWatch(arg1);
    console.log(`已移除 @${arg1} 的镜像监控。`);
    process.exit(0);
  }
  if (!command || !arg1 || !validHandle(command) || !validId(arg1) || extra.length) {
    throw new Error('用法：npm run mirror -- <目标用户名> <发帖账号数字ID> [--once] [--poll]');
  }
  const targetUsername = command;
  const posterId = arg1;

  const accounts = await new LocalMirrorClient(posterId).request('/api/accounts');
  const account = (accounts.accounts || []).find((a: { user?: { id?: string } }) => a.user?.id === posterId);
  if (!account) throw new Error(`未找到授权账号 ${posterId}，请先在 ${origin} 完成 X 授权`);
  const scope = (account.scope || '').split(/\s+/);
  if (!scope.includes('tweet.write') || !scope.includes('media.write')) throw new Error('发帖账号缺少 tweet.write / media.write 权限，请重新授权');

  const client = new LocalMirrorClient(posterId);
  const targetId = await client.lookup(targetUsername);
  store.registerWatch({ targetUsername, targetId, posterId });
  console.log(`已注册镜像监控：目标 @${targetUsername}（${targetId}）-> 发帖账号 ${posterId}。`);

  const intervalMs = Math.max(5000, Number(process.env.MIRROR_INTERVAL_MS) || 60_000);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let cooldownUntil = 0;
  const rateLimited = (error: unknown) => {
    const status = (error as { status?: number })?.status;
    const message = error instanceof Error ? error.message : String(error);
    return status === 429 || /429|rate.?limit/i.test(message);
  };
  const onPost = (tweetId: string, postedId: string) => console.log(`复制发帖 ${tweetId} -> ${postedId}`);

  /** 镜像一条推文（文本+图片）；单条失败只记录，不中断监听。 */
  async function mirrorOne(tweet: MirrorTweet) {
    const watch = store.getWatch(targetUsername);
    if (!watch) return;
    try {
      const outcome = await mirrorTweet({ store, watch, tweet, postTweet: (t, m) => client.postTweet(t, m), uploadImage: (u) => client.uploadImage(u), onPost });
      if (outcome === 'posted') { store.setSinceId(targetUsername, tweet.id); console.log(`已镜像 @${targetUsername} 的推文 ${tweet.id}`); }
    } catch (error) {
      if (rateLimited(error)) cooldownUntil = Date.now() + 15 * 60 * 1000;
      console.error(`镜像 ${tweet.id} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 启动回填：复制目标最新 3 条帖子（文本+图片）。 */
  async function backfill() {
    const watch = store.getWatch(targetUsername);
    if (!watch || !watch.targetId) return;
    const mirrorClient: MirrorClient = {
      fetchTimeline: (tid, sinceId) => client.fetchTimeline(tid, sinceId),
      uploadImage: (u) => client.uploadImage(u),
      postTweet: (t, m) => client.postTweet(t, m),
    };
    try {
      const result = await mirrorNewPosts({ store, watch, client: mirrorClient, onPost, limit: 3 });
      if (result.newestId && result.newestId !== watch.sinceId) store.setSinceId(targetUsername, result.newestId);
      console.log(`启动回填完成：复制 ${result.posted} 条，跳过 ${result.skipped} 条。`);
    } catch (error) {
      console.error(`启动回填失败（继续监听）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** filtered stream 循环；返回 false 表示该套餐不支持流，应回退 REST。 */
  async function streamLoop(): Promise<boolean> {
    let failures = 0;
    while (!stopping) {
      const now = Date.now();
      if (now < cooldownUntil) { await sleep(Math.min(cooldownUntil - now, 1000)); continue; }
      let response;
      try {
        response = await fetch(`${origin}/api/accounts/${posterId}/stream/tweets?${new URLSearchParams({ username: targetUsername })}`, { headers: { 'X-Local-Request': '1' } });
      } catch {
        console.error('无法连接本地授权服务，回退到 REST 轮询。');
        return false;
      }
      if (!response.ok || !response.body) {
        if ([400, 401, 403, 404].includes(response.status)) {
          console.error(`filtered stream 不可用（HTTP ${response.status}），回退到 REST 轮询。`);
          return false;
        }
        failures++;
        if (failures >= 3) { console.error('filtered stream 多次连接失败，回退到 REST 轮询。'); return false; }
        await sleep(Math.min(intervalMs, 5000 * failures));
        continue;
      }
      failures = 0;
      console.log('已连接 filtered stream，实时接收目标新帖。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let batch: StreamTweet[] = [];
      const parser = createStreamParser((t) => batch.push(t));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          batch = [];
          parser(decoder.decode(value, { stream: true }));
          for (const raw of batch) {
            if (stopping) break;
            const images = raw.mediaKeys.length ? await client.fetchMedia(raw.id) : [];
            await mirrorOne({ id: raw.id, text: raw.text, images });
          }
        }
      } catch {}
      console.log('流连接断开，稍后重连……');
      await sleep(Math.min(intervalMs, 5000));
    }
    return true;
  }

  /** REST 轮询循环，作为流的兜底。 */
  async function pollingLoop() {
    const mirrorClient: MirrorClient = {
      fetchTimeline: (tid, sinceId) => client.fetchTimeline(tid, sinceId),
      uploadImage: (u) => client.uploadImage(u),
      postTweet: (t, m) => client.postTweet(t, m),
    };
    while (!stopping) {
      const now = Date.now();
      if (now < cooldownUntil) { await sleep(Math.min(cooldownUntil - now, 1000)); continue; }
      try {
        const watch = store.getWatch(targetUsername);
        if (!watch) throw new Error('监控已被移除');
        const result = await mirrorNewPosts({ store, watch, client: mirrorClient, onPost });
        if (result.newestId && result.newestId !== watch.sinceId) store.setSinceId(targetUsername, result.newestId);
        if (result.posted) console.log(`已同步 ${result.posted} 条新帖；跳过 ${result.skipped} 条。`);
        if (once) break;
        await sleep(intervalMs);
      } catch (error) {
        if (rateLimited(error)) { cooldownUntil = Date.now() + 15 * 60 * 1000; console.error(`触发限流，冷却 15 分钟后重试：${error instanceof Error ? error.message : String(error)}`); }
        else console.error(`同步失败，稍后重试：${error instanceof Error ? error.message : String(error)}`);
        if (once) break;
        await sleep(intervalMs);
      }
    }
  }

  if (once) {
    await pollingLoop();
  } else {
    await backfill();
    if (forcePoll) {
      console.log('已强制使用 REST 轮询。');
      await pollingLoop();
    } else {
      const usedStream = await streamLoop();
      if (!usedStream) await pollingLoop();
    }
  }
} catch (error) {
  console.error(`镜像监控停止：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  store.close();
}
