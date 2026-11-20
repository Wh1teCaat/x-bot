import { open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * exporter24 同一时间只允许一个任务（粉丝抓取或补数搜索）。
 * 这是跨进程文件锁：持有者崩溃时会按 PID 失效，避免永久卡住。
 */
export const EXPORTER_LOCK_PATH = resolve('.data', 'exporter.lock');

export type ExporterLockOptions = { timeoutMs?: number; pollMs?: number };

/** 获取锁并返回释放函数；调用方必须在 finally 里释放。 */
export async function acquireExporterLock({ timeoutMs = 15 * 60 * 1000, pollMs = 500 }: ExporterLockOptions = {}) {
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(EXPORTER_LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const info = JSON.parse(await readFile(EXPORTER_LOCK_PATH, 'utf8'));
        if (!Number.isInteger(info.pid)) stale = true;
        else {
          try { process.kill(info.pid, 0); }
          catch (killError) { if (killError.code === 'ESRCH') stale = true; }
        }
      } catch { stale = true; }
      if (stale) { await unlink(EXPORTER_LOCK_PATH).catch(() => {}); continue; }
      if (Date.now() - started >= timeoutMs) throw new Error('等待 exporter 锁超时（另一个任务仍在运行）');
      await new Promise(resolveWait => setTimeout(resolveWait, pollMs));
      continue;
    }
    return async () => {
      await handle.close().catch(() => {});
      await unlink(EXPORTER_LOCK_PATH).catch(() => {});
    };
  }
}

/** 在锁内执行 fn。 */
export async function withExporterLock<T>(fn: () => Promise<T>, options: ExporterLockOptions = {}): Promise<T> {
  const release = await acquireExporterLock(options);
  try { return await fn(); }
  finally { await release(); }
}
