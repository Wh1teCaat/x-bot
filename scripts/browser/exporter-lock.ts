import { open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * exporter24 同一时间只允许一个任务（粉丝抓取或补数搜索）。
 * 这是跨进程文件锁：持有者崩溃时会按 PID 失效，避免永久卡住。
 */
export const EXPORTER_LOCK_PATH = resolve('.data', 'exporter.lock');

export type ExporterLockOptions = { timeoutMs?: number; pollMs?: number; lockPath?: string };

/** 获取锁并返回释放函数；调用方必须在 finally 里释放。 */
export async function acquireExporterLock({ timeoutMs = 15 * 60 * 1000, pollMs = 500, lockPath = EXPORTER_LOCK_PATH }: ExporterLockOptions = {}) {
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const info = JSON.parse(await readFile(lockPath, 'utf8'));
        if (!Number.isInteger(info.pid)) stale = true;
        else {
          try { process.kill(info.pid, 0); }
          catch (killError) { if (killError.code === 'ESRCH') stale = true; }
        }
      } catch { stale = true; }
      if (stale) { await unlink(lockPath).catch(() => {}); continue; }
      if (Date.now() - started >= timeoutMs) throw new Error('等待 exporter 锁超时（另一个任务仍在运行）');
      await new Promise(resolveWait => setTimeout(resolveWait, pollMs));
      continue;
    }
    return async () => {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    };
  }
}

/** 同一账号的重试状态由一个进程推进；等待退避期间不占全局扩展锁。 */
export async function withExporterRetryLock<T>(account: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = account || 'shared';
  if (key !== 'shared' && !/^\d{1,19}$/.test(key)) throw new Error('exporter 账号 ID 无效');
  const release = await acquireExporterLock({ lockPath: resolve('.data', `exporter-retry-${key}.lock`), timeoutMs: 4 * 60 * 60_000, pollMs: 5000 });
  try { return await fn(); } finally { await release(); }
}

/** 在锁内执行 fn。 */
export async function withExporterLock<T>(fn: () => Promise<T>, options: ExporterLockOptions = {}): Promise<T> {
  const release = await acquireExporterLock(options);
  try { return await fn(); }
  finally { await release(); }
}
