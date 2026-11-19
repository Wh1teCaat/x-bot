import '../../src/runtime-config.ts';
/** exporter24 的分页游标留在扩展历史中，本地只提交已筛选入队的偏移。 */
import type { Page } from 'playwright';
import type { DatabaseSync } from 'node:sqlite';
import { ensureExporter24Auth, readExporter24Gate } from './exporter24.ts';

export const FOLLOWER_BATCH_SIZE = 200;
/** 导出节奏；关注速率由 Outbox worker 单独限制，这里只控制抓取批次间隔。 */
export const FOLLOWER_INTERVAL_MS = 5 * 60 * 1000;
export type FollowerCheckpoint = { taskId: string | null; offset: number; due: number; done: boolean };
export class FollowerCheckpoints {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS follower_checkpoints (
      account TEXT NOT NULL, blogger TEXT NOT NULL, task_id TEXT, offset INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account,blogger))`);
  }
  get(account: string, blogger: string): FollowerCheckpoint {
    const row = this.db.prepare('SELECT * FROM follower_checkpoints WHERE account=? AND blogger=?').get(account, blogger.toLowerCase());
    return row ? { taskId: row.task_id as string, offset: Number(row.offset), due: Number(row.due), done: Boolean(row.done) }
      : { taskId: null, offset: 0, due: 0, done: false };
  }
  save(account: string, blogger: string, value: FollowerCheckpoint) {
    this.db.prepare(`INSERT INTO follower_checkpoints VALUES (?,?,?,?,?,?) ON CONFLICT(account,blogger)
      DO UPDATE SET task_id=excluded.task_id,offset=excluded.offset,due=excluded.due,done=excluded.done`)
      .run(account, blogger.toLowerCase(), value.taskId, value.offset, value.due, Number(value.done));
  }
}

/** 从 React 组件的 source 属性取得扩展自己的 store；版本不兼容时停止。 */
export async function attachFollowerStore(page: Page) {
  await page.waitForFunction(() => {
    const root = document.getElementById('ext-root');
    const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
    const fiber = key && (root as any)[key];
    const queue = fiber ? [fiber, fiber.alternate].filter(Boolean) : [];
    const seen = new Set();
    while (queue.length) {
      const item = queue.pop();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      const source = item.memoizedProps?.source;
      if (source && typeof source.fetchFollowList === 'function' && source.cooldownManager) {
        (globalThis as any).__followerStore = source;
        return true;
      }
      queue.push(item.child, item.sibling);
    }
    return false;
  }, undefined, { timeout: 30000 });
}

/** 只在完整分页保存后暂停，多出的本页记录保留在扩展中，下批先消费。 */
async function readFollowerBatchOnce(page: Page, username: string, checkpoint: FollowerCheckpoint,
  saveTask: (id: string) => void, guard: () => void | Promise<void>) {
  if (checkpoint.taskId) {
    const url = new URL(page.url());
    url.search = new URLSearchParams({ taskId: checkpoint.taskId, tab: 'follower' }).toString();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  } else {
    const url = new URL(page.url());
    url.search = new URLSearchParams({ type: 'followers', username, confirmed: '1' }).toString();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  }
  await attachFollowerStore(page);
  // 新任务仅创建，不自动点击 Start；先装好分页边界暂停钩子。
  await page.waitForFunction(() => Boolean((globalThis as any).__followerStore.task), undefined, { timeout: 30000 });
  const taskId = await page.evaluate(({ username, expected }) => {
    const s = (globalThis as any).__followerStore;
    if (s.task.type !== 'followers' || s.task.src?.username?.toLowerCase() !== username.toLowerCase()) throw new Error('exporter24 粉丝任务身份不匹配');
    if (expected && s.task.id !== expected) throw new Error('exporter24 未恢复指定历史任务');
    if (s.runningTaskId || s.isProcessing) throw new Error('exporter24 已有正在执行的任务');
    return String(s.task.id);
  }, { username, expected: checkpoint.taskId });
  saveTask(taskId);
  const target = checkpoint.offset + FOLLOWER_BATCH_SIZE;
  await page.evaluate(async target => {
    const s = (globalThis as any).__followerStore;
    const manager = s.cooldownManager;
    const original = manager.sleepForSearch.bind(manager);
    manager.sleepForSearch = async (...args: any[]) => {
      if (s.fetchedCount >= target) { await s.stopRun(); return; }
      return original(...args);
    };
    if (s.fetchedCount < target && s.profileList.hasMore) await s.toggleRun();
  }, target);
  const deadline = Date.now() + Math.max(30000, Number(process.env.FOLLOWER_EXPORT_TIMEOUT_MS) || 600000);
  while (true) {
    await guard();
    const progress = await page.evaluate(() => {
      const s = (globalThis as any).__followerStore;
      return { running: Boolean(s.runningTaskId || s.isProcessing), count: s.fetchedCount, more: Boolean(s.profileList.hasMore) };
    });
    if (!progress.running) {
      if (progress.count < target && progress.more) throw new Error('exporter24 未完成本批抓取，请检查登录、额度或限流；断点未提交');
      break;
    }
    if (Date.now() >= deadline) throw new Error('exporter24 本批抓取超时；请检查扩展任务后恢复');
    await page.waitForTimeout(500);
  }
  return page.evaluate(async ({ offset, size }) => {
    const s = (globalThis as any).__followerStore;
    if (!s.profileChunkStore?.queryPage) throw new Error('exporter24 版本不支持分页断点');
    const list = await s.profileChunkStore.queryPage({ page: offset / size + 1, pageSize: size });
    const candidates = list.map(user => {
      if (!/^[A-Za-z0-9_]{1,15}$/.test(user.username) || !/^\d{1,19}$/.test(String(user.uid))) throw new Error('exporter24 返回无效用户');
      return { username: user.username, userId: String(user.uid), profileUrl: `https://x.com/${user.username}`, replies: [], followers: user.subsCount, following: user.followingCount };
    });
    return { candidates, nextOffset: offset + list.length, done: !s.profileList.hasMore && offset + list.length >= s.fetchedCount };
  }, { offset: checkpoint.offset, size: FOLLOWER_BATCH_SIZE });
}

/**
 * 抓取一批粉丝；遇到 5 星评价/登录门槛时用 X_EXPORT_TOKEN 登录并重试一次。
 * 登录会重新加载扩展页，任务从已保存的历史断点（taskId）继续，本地偏移不变。
 */
export async function readFollowerBatch(page: Page, username: string, checkpoint: FollowerCheckpoint,
  saveTask: (id: string) => void, guard: () => void | Promise<void>) {
  await ensureExporter24Auth(page, guard);
  let loggedIn = false, retried = false;
  for (;;) {
    try {
      return await readFollowerBatchOnce(page, username, checkpoint, saveTask, guard);
    } catch (error) {
      if (await readExporter24Gate(page)) {
        if (loggedIn) throw error;
        loggedIn = true;
        await ensureExporter24Auth(page, guard);
        continue;
      }
      // 扩展页偶发挂载慢（浏览器刚跑完 10 条帖子扫描时尤其明显），重载任务页再试一次。
      if (!retried && /waitForFunction|Timeout/i.test(String(error?.message || error))) {
        retried = true;
        console.log('exporter24 任务页未在时限内就绪，重新加载后重试一次。');
        await page.waitForTimeout(2000);
        continue;
      }
      throw error;
    }
  }
}
