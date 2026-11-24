import type { Page } from 'playwright';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';

type Entry = { key: unknown; value: unknown };
export type ExporterHistorySnapshot = { version: number; stores: Record<string, Entry[]> };
const DB = 'IGE24Store';
const STORES = ['ig_exporter_24_store', 'ig_exporter_24_store_chunks', 'ig_exporter_24_store_comments', 'local-forage-detect-blob-support'];
function checkOrigin(page: Page) {
  if (!page.url().startsWith(`chrome-extension://${EXPORTER24_EXTENSION_ID}/`)) throw new Error('必须在 exporter24 扩展页面操作历史');
}

/** 仅清空已确认备份的扩展历史，不删除插件权限或 exporter 登录。 */
export async function clearExporterHistory(page: Page): Promise<void> {
  checkOrigin(page);
  await page.evaluate(async ({ database, names }) => {
    if (!(await indexedDB.databases()).some(item => item.name === database)) return;
    const db = await new Promise<IDBDatabase>((ok, no) => { const q = indexedDB.open(database); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); q.onblocked = () => no(new Error('历史数据库被占用')); });
    try {
      const present = names.filter(name => db.objectStoreNames.contains(name));
      if (!present.length) return;
      await new Promise<void>((ok, no) => {
        const tx = db.transaction(present, 'readwrite');
        for (const name of present) tx.objectStore(name).clear();
        tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error || new Error('清理历史失败'));
      });
    } finally { db.close(); }
  }, { database: DB, names: STORES });
}

/** 从账号副本读取扩展历史，不输出或修改原数据库。 */
export async function readExporterHistory(page: Page): Promise<ExporterHistorySnapshot> {
  checkOrigin(page);
  return page.evaluate(async ({ database, names }) => {
    if (!(await indexedDB.databases()).some(item => item.name === database)) throw new Error('源历史数据库不存在');
    const db = await new Promise<IDBDatabase>((ok, no) => { const q = indexedDB.open(database); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); q.onblocked = () => no(new Error('源历史数据库被占用')); });
    try {
      const present = names.filter(name => db.objectStoreNames.contains(name));
      return await new Promise<ExporterHistorySnapshot>((ok, no) => {
        const stores: Record<string, Entry[]> = Object.fromEntries(names.map(name => [name, []]));
        if (!present.length) { ok({ version: db.version, stores }); return; }
        const tx = db.transaction(present, 'readonly');
        for (const name of present) {
          const store = tx.objectStore(name);
          if (store.keyPath !== null) { tx.abort(); return; }
          const cursor = store.openCursor();
          cursor.onsuccess = () => { const row = cursor.result; if (row) { stores[name].push({ key: row.key, value: row.value }); row.continue(); } };
        }
        tx.oncomplete = () => ok({ version: db.version, stores });
        tx.onerror = () => no(tx.error || new Error('读取历史失败'));
        tx.onabort = () => no(tx.error || new Error('历史数据库结构不兼容'));
      });
    } finally { db.close(); }
  }, { database: DB, names: STORES });
}

/** 仅向空白测试窗口写入完整历史；所有表在同一事务中提交。 */
export async function writeExporterHistory(page: Page, snapshot: ExporterHistorySnapshot): Promise<void> {
  checkOrigin(page);
  if (!snapshot || !Number.isInteger(snapshot.version) || STORES.some(name => !Array.isArray(snapshot.stores?.[name]))) throw new Error('源历史快照无效');
  await page.evaluate(async ({ database, names, snapshot }) => {
    const current = (await indexedDB.databases()).find(item => item.name === database);
    if (current && Number(current.version) > snapshot.version) throw new Error('目标扩展历史版本高于来源，未导入');
    if (current) {
      const existing = await new Promise<IDBDatabase>((ok, no) => { const q = indexedDB.open(database); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
      try {
        const present = names.filter(name => existing.objectStoreNames.contains(name));
        if (present.length) await new Promise<void>((ok, no) => {
          const tx = existing.transaction(present, 'readonly');
          let nonempty = false;
          for (const name of present) { const q = tx.objectStore(name).count(); q.onsuccess = () => { if (q.result) { nonempty = true; tx.abort(); } }; }
          tx.oncomplete = () => ok(); tx.onabort = tx.onerror = () => no(nonempty ? new Error('目标历史非空，未覆盖任何记录') : tx.error || new Error('检查目标历史失败'));
        });
      } finally { existing.close(); }
    }
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const q = indexedDB.open(database, snapshot.version);
      q.onupgradeneeded = () => { for (const name of names) if (!q.result.objectStoreNames.contains(name)) q.result.createObjectStore(name); };
      q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); q.onblocked = () => no(new Error('目标历史数据库被占用，请关闭其他扩展页面'));
    });
    try {
      if (db.version !== snapshot.version || names.some(name => !db.objectStoreNames.contains(name) && snapshot.stores[name].length)) throw new Error('目标扩展历史版本不兼容');
      await new Promise<void>((ok, no) => {
        const present = names.filter(name => db.objectStoreNames.contains(name));
        if (!present.length) { ok(); return; }
        const tx = db.transaction(present, 'readwrite');
        let remaining = present.length;
        for (const name of present) {
          const store = tx.objectStore(name);
          if (store.keyPath !== null) { tx.abort(); return; }
          const count = store.count();
          count.onsuccess = () => {
            if (count.result !== 0) { tx.abort(); return; }
            if (--remaining === 0) for (const key of present) for (const entry of snapshot.stores[key]) tx.objectStore(key).add(entry.value, entry.key as IDBValidKey);
          };
        }
        tx.oncomplete = () => ok();
        tx.onerror = () => no(tx.error || new Error('导入历史失败'));
        tx.onabort = () => no(tx.error || new Error('目标历史非空或结构不兼容，未覆盖任何记录'));
      });
    } finally { db.close(); }
  }, { database: DB, names: STORES, snapshot });
}
