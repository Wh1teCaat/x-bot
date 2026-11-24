import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import type { BrowserContext } from 'playwright';
import { acquireExporterLock } from './exporter-lock.ts';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { clearExporterHistory, readExporterHistory, writeExporterHistory, type ExporterHistorySnapshot } from './bitbrowser-history-transfer.ts';

async function atomic(path: string, data: string | Buffer) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path);
}
async function json(path: string, fallback: any) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
}

/** 切换窗口前先保存上个账号的历史；中断时按 transition 标记重新完成切换。 */
export async function prepareBitWindowAccount(context: BrowserContext, windowId: string, account: string, cookieAuth: string | undefined, root = resolve('.data')) {
  if (!/^\d{1,19}$/.test(account) || !/^[A-Za-z0-9_-]{1,128}$/.test(windowId)) throw new Error('窗口或账号无效');
  const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-window-state.lock') });
  const path = resolve(root, 'bitbrowser-window-owners.json');
  const snapshotPath = (id: string) => resolve(root, 'account-data', id, 'bit-exporter-history.bin');
  let page;
  try {
    const data = await json(path, { version: 1, windows: {} });
    if (data.version !== 1 || !data.windows || typeof data.windows !== 'object') throw new Error('比特窗口归属记录无效');
    let entry = data.windows[windowId];
    if (!entry) {
      const bindings = await json(resolve(root, 'bitbrowser-bindings.json'), { accounts: {} });
      const owners = Object.entries(bindings.accounts || {}).filter(([, value]: [string, any]) => value?.windowId === windowId).map(([key]) => key);
      if (owners.length > 1) throw new Error('窗口的原账号归属不明确');
      entry = owners.length ? { owner: owners[0] } : { owner: null };
      if (entry.owner) { data.windows[windowId] = entry; await atomic(path, JSON.stringify(data)); }
    }
    if (entry.owner && !/^\d{1,19}$/.test(entry.owner)) throw new Error('窗口原账号记录无效');
    page = await context.newPage();
    await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
    const hasDb = () => page!.evaluate(async () => (await indexedDB.databases()).some(item => item.name === 'IGE24Store'));
    if (!entry.owner && !entry.transition) {
      const cookies = await context.cookies(['https://x.com', 'https://twitter.com']);
      if (cookies.some(c => c.name === 'auth_token' && c.value !== cookieAuth)) throw new Error('空闲窗口有未知账号的 X 登录，未覆盖');
      if (await hasDb()) {
        const history = await readExporterHistory(page);
        if (['ig_exporter_24_store', 'ig_exporter_24_store_chunks', 'ig_exporter_24_store_comments'].some(name => history.stores[name]?.length)) throw new Error('空闲窗口有归属不明的 exporter 历史，未覆盖');
      }
      let saved: ExporterHistorySnapshot | null = null;
      try { saved = deserialize(await readFile(snapshotPath(account))); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('账号 exporter 历史备份无法读取', { cause: e }); }
      if (saved) { await clearExporterHistory(page); await writeExporterHistory(page, saved); }
      data.windows[windowId] = { owner: account }; await atomic(path, JSON.stringify(data));
      return !!saved;
    }
    if (entry.owner === account && !entry.transition) {
      const present = await hasDb() ? await readExporterHistory(page) : null;
      const nonempty = present && ['ig_exporter_24_store', 'ig_exporter_24_store_chunks', 'ig_exporter_24_store_comments'].some(name => present.stores[name]?.length);
      if (!nonempty) {
        let saved: ExporterHistorySnapshot | null = null;
        try { saved = deserialize(await readFile(snapshotPath(account))); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('账号 exporter 历史备份无法读取', { cause: e }); }
        if (saved) { await clearExporterHistory(page); await writeExporterHistory(page, saved); console.log(`已恢复账号 ${account} 的 exporter 历史。`); return true; }
      }
      return false;
    }
    if (!entry.transition) {
      const snapshot = await hasDb() ? await readExporterHistory(page) : null;
      await atomic(snapshotPath(entry.owner), serialize(snapshot));
      entry.transition = true; data.windows[windowId] = entry; await atomic(path, JSON.stringify(data));
    }
    // 转换记录先于清理落盘；异常重试不会把半成品当作上个账号历史备份。
    for (const oldPage of context.pages()) {
      if (oldPage === page) continue;
      const url = oldPage.url();
      if (/^https?:\/\/(?:[^/]+\.)?(?:x|twitter)\.com(?:[/:?#]|$)/i.test(url) || url.startsWith(`chrome-extension://${EXPORTER24_EXTENSION_ID}/`)) await oldPage.close();
    }
    await clearExporterHistory(page);
    await context.clearCookies({ domain: /(^|\.)(x|twitter)\.com$/i });
    const cdp = await context.newCDPSession(page);
    try { for (const origin of ['https://x.com', 'https://www.x.com', 'https://twitter.com', 'https://www.twitter.com']) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); }
    finally { await cdp.detach(); }
    let saved: ExporterHistorySnapshot | null = null;
    try { saved = deserialize(await readFile(snapshotPath(account))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('账号 exporter 历史备份无法读取', { cause: e }); }
    if (saved) await writeExporterHistory(page, saved);
    data.windows[windowId] = { owner: account }; await atomic(path, JSON.stringify(data));
    console.log(saved ? `已恢复账号 ${account} 的 exporter 历史。` : `账号 ${account} 在此窗口没有 exporter 历史，将从头抓取。`);
    return true;
  } finally { await page?.close().catch(() => {}); await unlock(); }
}

/** 正常退出时保存账号历史，原窗口暂不可用时可在其他窗口恢复。 */
export async function saveBitWindowAccount(context: BrowserContext, windowId: string, account: string, root = resolve('.data')) {
  const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-window-state.lock') });
  let page;
  try {
    const data = await json(resolve(root, 'bitbrowser-window-owners.json'), { version: 1, windows: {} });
    const entry = data.windows?.[windowId];
    if (!entry || entry.owner !== account || entry.transition) throw new Error('窗口归属不匹配，不能保存账号历史');
    page = await context.newPage(); await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
    const exists = await page.evaluate(async () => (await indexedDB.databases()).some(item => item.name === 'IGE24Store'));
    const snapshot = exists ? await readExporterHistory(page) : null;
    await atomic(resolve(root, 'account-data', account, 'bit-exporter-history.bin'), serialize(snapshot));
  } finally { await page?.close().catch(() => {}); await unlock(); }
}
