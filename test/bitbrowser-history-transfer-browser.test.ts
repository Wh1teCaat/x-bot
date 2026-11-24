import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXPORTER24_EXTENSION_ID } from '../scripts/browser/exporter24.ts';
import { readExporterHistory, writeExporterHistory } from '../scripts/browser/bitbrowser-history-transfer.ts';
import { resumeLatestFollowerTask } from '../scripts/browser/follower-batch.ts';
import { prepareBitWindowAccount, saveBitWindowAccount } from '../scripts/browser/bitbrowser-window-state.ts';

test('迁移扩展任务和分页数据，拒绝覆盖非空目标', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-bit-history-'));
  const ext = resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID);
  const contexts = [];
  try {
    const executable = chromium.executablePath().replace(join(homedir(), 'Library/Caches/ms-playwright'), resolve('.data/playwright-browsers'));
    for (let i = 0; i < 2; i++) contexts.push(await chromium.launchPersistentContext(join(root, String(i)), { headless: true, chromiumSandbox: true, executablePath: executable, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] }));
    const [source, target] = await Promise.all(contexts.map(async context => { const page = await context.newPage(); await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`); return page; }));
    await source.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((ok, no) => { const r = indexedDB.open('IGE24Store', 4); r.onupgradeneeded = () => { for (const name of ['ig_exporter_24_store','ig_exporter_24_store_chunks','ig_exporter_24_store_comments','local-forage-detect-blob-support']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      try { await new Promise<void>((ok, no) => { const tx = db.transaction(['ig_exporter_24_store','ig_exporter_24_store_chunks'], 'readwrite'); tx.objectStore('ig_exporter_24_store').put({ id: 'task', type: 'followers', src: { username: 'alice' }, updatedAt: 100, storage: { version: 'v2', totalFetched: 600 } }, 'task'); tx.objectStore('ig_exporter_24_store_chunks').put({ list: Array.from({ length: 600 }, (_, i) => ({ uid: String(i) })) }, 'profile:task:0'); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); }); } finally { db.close(); }
    });
    const snapshot = await readExporterHistory(source);
    await target.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((ok, no) => { const r = indexedDB.open('IGE24Store', 3); r.onupgradeneeded = () => { for (const name of ['ig_exporter_24_store', 'ig_exporter_24_store_comments', 'local-forage-detect-blob-support']) r.result.createObjectStore(name); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      db.close();
    });
    assert.equal((await readExporterHistory(target)).stores.ig_exporter_24_store_chunks.length, 0);
    await writeExporterHistory(target, snapshot);
    assert.equal(await resumeLatestFollowerTask(target, 'alice'), 'task');
    const restored = await readExporterHistory(target);
    assert.deepEqual(restored, snapshot);
    await assert.rejects(writeExporterHistory(target, snapshot), /目标历史非空/);
    assert.deepEqual(await readExporterHistory(target), snapshot);
    // 同一窗口先属于账号 1，切换到账号 2 再切回，账号 1 的历史必须恢复。
    await writeFile(join(root, 'bitbrowser-bindings.json'), JSON.stringify({ version: 1, accounts: { '1': { windowId: 'window', apiUrl: 'http://127.0.0.1:54345' } } }));
    await prepareBitWindowAccount(contexts[1], 'window', '1', undefined, root);
    await saveBitWindowAccount(contexts[1], 'window', '1', root);
    await contexts[1].addCookies([{ name: 'auth_token', value: 'account-one-test', domain: '.x.com', path: '/', secure: true }]);
    await prepareBitWindowAccount(contexts[1], 'window', '2', undefined, root);
    assert.equal((await contexts[1].cookies('https://x.com')).some(cookie => cookie.name === 'auth_token'), false);
    let verify = await contexts[1].newPage(); await verify.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
    assert.equal(await resumeLatestFollowerTask(verify, 'alice'), null);
    // 模拟备份后进程中断，重试不能将半成品当作原账号历史。
    await writeFile(join(root, 'bitbrowser-window-owners.json'), JSON.stringify({ version: 1, windows: { window: { owner: '2', transition: true } } }));
    await prepareBitWindowAccount(contexts[1], 'window', '1', undefined, root);
    verify = await contexts[1].newPage(); await verify.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
    assert.deepEqual(await readExporterHistory(verify), snapshot);
  } finally { await Promise.all(contexts.map(c => c.close())); await rm(root, { recursive: true, force: true }); }
});
