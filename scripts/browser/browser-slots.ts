import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 跨进程限制浏览器数量；槽位仅代表并发许可，账号资料始终独立。 */
export type BrowserSlotRelease = (() => void) & { slot: number };
export async function acquireBrowserSlot(account: string, options: { path?: string; limit?: number; pollMs?: number; cancelled?: () => boolean; onWait?: () => void } = {}): Promise<BrowserSlotRelease> {
  const path = options.path ?? resolve('.data', 'browser-slots.sqlite');
  await mkdir(resolve(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=10000');
  db.exec('CREATE TABLE IF NOT EXISTS browser_slots (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL, account TEXT NOT NULL)');
  const owner = randomUUID(), limit = options.limit ?? 5;
  let announced = false;
  try {
    for (;;) {
      if (options.cancelled?.()) throw new Error('等待浏览器槽位时已取消');
      db.exec('BEGIN IMMEDIATE');
      let selected = 0;
      try {
        const rows = db.prepare('SELECT slot,pid FROM browser_slots').all() as { slot: number; pid: number }[];
        for (const row of rows) {
          try { process.kill(row.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') db.prepare('DELETE FROM browser_slots WHERE slot=? AND pid=?').run(row.slot, row.pid); }
        }
        const used = new Set((db.prepare('SELECT slot FROM browser_slots').all() as { slot: number }[]).map(row => row.slot));
        for (let slot = 1; slot <= limit; slot++) if (!used.has(slot)) { selected = slot; break; }
        if (selected) db.prepare('INSERT INTO browser_slots VALUES (?,?,?,?)').run(selected, process.pid, owner, account);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (selected) {
        let released = false;
        return Object.assign(() => { if (released) return; released = true; try { db.prepare('DELETE FROM browser_slots WHERE slot=? AND owner=?').run(selected, owner); } finally { db.close(); } }, { slot: selected });
      }
      if (!announced) { announced = true; options.onWait?.(); }
      await new Promise(resolveWait => setTimeout(resolveWait, options.pollMs ?? 2000));
    }
  } catch (error) { db.close(); throw error; }
}
