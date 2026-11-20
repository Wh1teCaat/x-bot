import '../../src/runtime-config.ts';
/** exporter24 的分页游标留在扩展历史中，本地只提交已筛选入队的偏移。 */
import type { Page } from 'playwright';
import type { DatabaseSync } from 'node:sqlite';
import { ensureExporter24Auth, readExporter24Gate, EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { ExporterError } from './exporter-retry.ts';

export const FOLLOWER_BATCH_SIZE = 200;
/** 导出节奏；关注速率由 Outbox worker 单独限制，这里只控制抓取批次间隔。 */
export const FOLLOWER_INTERVAL_MS = 15 * 60 * 1000;

/** 只在能证明扩展采集已停止时允许重新运行。 */
export async function stopFollowerBatchForRetry(page: Page): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      page.evaluate(async () => {
        const store = (globalThis as any).__followerStore;
        if (!store) throw new Error('扩展状态不可用');
        if (store.runningTaskId || store.isProcessing) {
          if (typeof store.stopRun !== 'function') throw new Error('扩展停止接口不可用');
          await store.stopRun();
        }
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('扩展停止超时')), 10_000); }),
    ]);
    await page.waitForFunction(() => {
      const store = (globalThis as any).__followerStore;
      return Boolean(store && !store.runningTaskId && !store.isProcessing);
    }, undefined, { timeout: 10_000 });
    return true;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}
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
export async function attachFollowerStore(page: Page, timeout = 30000) {
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
  }, undefined, { timeout });
}

/** 只在完整分页保存后暂停，多出的本页记录保留在扩展中，下批先消费。 */
async function readFollowerBatchOnce(page: Page, username: string, checkpoint: FollowerCheckpoint,
  saveTask: (id: string) => void, guard: () => void | Promise<void>) {
  let reused = false;
  if (checkpoint.taskId) {
    // 常驻粉丝页：页面没关时直接复用内存里的任务，避免按 taskId 重新加载。
    for (let attempt = 0; attempt < 3 && !reused; attempt++) {
      try {
        await attachFollowerStore(page, 2000);
        const openTaskId = await page.evaluate(() => (globalThis as any).__followerStore?.task?.id ?? null);
        reused = String(openTaskId) === checkpoint.taskId;
      } catch { /* 页面还没挂载，稍后重试 */ }
      if (!reused) await page.waitForTimeout(800);
    }
  }
  if (!reused) {
    const url = new URL(page.url());
    url.search = checkpoint.taskId
      ? new URLSearchParams({ taskId: checkpoint.taskId, tab: 'follower' }).toString()
      : new URLSearchParams({ type: 'followers', username, confirmed: '1' }).toString();
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
 * 历史任务页加载不出来时，用 History 里最新一条该博主的粉丝任务恢复。
 * 扩展的 History 行点击后会跳到 index.html?taskId=<最新任务>&tab=follower，返回这个任务 ID。
 */
export async function resumeLatestFollowerTask(page: Page, username: string): Promise<string | null> {
  await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/history.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('tbody tr').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  const rows = page.locator('tbody tr');
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const text = await rows.nth(index).innerText().catch(() => '');
    if (!text.toLowerCase().includes(`@${username.toLowerCase()}`) || !/FOLLOWERS/i.test(text)) continue;
    await rows.nth(index).click();
    await page.waitForFunction(() => /[?&]taskId=/.test(location.href), undefined, { timeout: 15000 }).catch(() => {});
    const taskId = new URL(page.url()).searchParams.get('taskId');
    if (!taskId) return null;
    await attachFollowerStore(page, 30000);
    const openTaskId = await page.evaluate(() => (globalThis as any).__followerStore?.task?.id ?? null);
    return String(openTaskId) === taskId ? taskId : null;
  }
  return null;
}

/**
 * 抓取一批粉丝；遇到 5 星评价/登录门槛时用 X_EXPORT_TOKEN 登录并重试一次。
 * 登录会重新加载扩展页，任务从已保存的历史断点（taskId）继续，本地偏移不变。
 */
export async function readFollowerBatch(page: Page, username: string, checkpoint: FollowerCheckpoint,
  saveTask: (id: string) => void, guard: () => void | Promise<void>, options: { recoverTimeout?: boolean } = {}) {
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
      // 任务页加载不出来时，先用 History 最新一条恢复；没有可恢复任务才新建，按本地 offset 从 0 补抓。
      if (options.recoverTimeout && !retried && /waitForFunction|Timeout/i.test(String(error?.message || error))) {
        retried = true;
        if (!await stopFollowerBatchForRetry(page)) throw new ExporterError('无法确认 exporter24 任务已停止，请人工检查后恢复', false, error);
        if (checkpoint.taskId) {
          console.log('exporter24 历史任务加载失败，尝试从 History 最新一条恢复。');
          const latest = await resumeLatestFollowerTask(page, username).catch((resumeError) => {
            console.log(`从 History 恢复失败：${resumeError?.message || resumeError}`);
            return null;
          });
          if (latest) {
            checkpoint.taskId = latest;
            saveTask(latest);
            console.log(`已恢复 History 最新任务 ${latest}，从本地 offset ${checkpoint.offset} 继续。`);
          } else {
            console.log('History 中没有可恢复的粉丝任务，改用新任务并按本地 offset 继续（会从 0 补抓）。');
            checkpoint.taskId = null;
          }
        } else {
          console.log('exporter24 任务页未在时限内就绪，重新加载后重试一次。');
        }
        await page.waitForTimeout(2000);
        continue;
      }
      throw error;
    }
  }
}
