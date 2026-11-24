import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireExporterLock } from './exporter-lock.ts';
import { BitBrowserClient, localBitBrowserOrigin } from './bitbrowser-client.ts';

/** 跨进程租用窗口，按历史窗口优先，窗口关闭后才能释放。 */
export async function acquireBitWindow(account: string, preferred: string, apiUrl: string, options: { root?: string; cancelled?: () => boolean; onWait?: () => void; pollMs?: number; isOpen?: (id: string) => Promise<boolean> } = {}) {
  const root = options.root ?? resolve('.data');
  const registry = JSON.parse(await readFile(resolve(root, 'bitbrowser-pool.json'), 'utf8'));
  if (registry.version !== 1 || localBitBrowserOrigin(registry.origin) !== localBitBrowserOrigin(apiUrl) || !Array.isArray(registry.slots)) throw new Error('比特浏览器工作池配置无效');
  const ids = registry.slots.filter((s: any) => s.verified && /^[A-Za-z0-9_-]{1,128}$/.test(s.id)).sort((a: any, b: any) => a.number - b.number).map((s: any) => s.id as string);
  if (!ids.includes(preferred) || new Set(ids).size !== ids.length) throw new Error('比特浏览器首选窗口不在工作池中');
  ids.sort((a: string, b: string) => Number(b === preferred) - Number(a === preferred));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(root, 'bitbrowser-window-leases.sqlite'));
  db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS leases (window_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL, account TEXT NOT NULL)');
  const client = new BitBrowserClient(apiUrl), owner = randomUUID();
  let announced = false;
  try {
    for (;;) {
      if (options.cancelled?.()) throw new Error('等待比特窗口时已取消');
      const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-window-leases.lock') });
      try {
        const rows = db.prepare('SELECT window_id,pid FROM leases').all() as { window_id: string; pid: number }[];
        for (const row of rows) try { process.kill(row.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') db.prepare('DELETE FROM leases WHERE window_id=? AND pid=?').run(row.window_id, row.pid); }
        const used = new Set((db.prepare('SELECT window_id FROM leases').all() as { window_id: string }[]).map(row => row.window_id));
        for (const id of ids) {
          if (used.has(id) || await (options.isOpen ? options.isOpen(id) : client.isOpen(id))) continue;
          db.prepare('INSERT INTO leases VALUES (?,?,?,?)').run(id, process.pid, owner, account);
          let released = false;
          return { windowId: id, async release() { if (released) return; released = true; try { db.prepare('DELETE FROM leases WHERE window_id=? AND owner=?').run(id, owner); } finally { db.close(); } } };
        }
      } finally { await unlock(); }
      if (!announced) { announced = true; options.onWait?.(); }
      await new Promise(ok => setTimeout(ok, options.pollMs ?? 2000));
    }
  } catch (error) { db.close(); throw error; }
}
