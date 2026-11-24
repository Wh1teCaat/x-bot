import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXPORTER24_EXTENSION_ID } from '../scripts/browser/exporter24.ts';
import { resumeLatestFollowerTask } from '../scripts/browser/follower-batch.ts';
import { prepareRuntimeProfile } from '../scripts/browser/runtime-profile.ts';

test('reads the newest exact follower history from the real extension database', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-history-integration-'));
  const extension = resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID);
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { executablePath: chromium.executablePath(), headless: true, chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/history.html`);
    await page.locator('table tbody').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((yes, no) => { const r = indexedDB.open('IGE24Store'); r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
      try {
        await new Promise<void>((yes, no) => {
          const tx = db.transaction('ig_exporter_24_store', 'readwrite'); const store = tx.objectStore('ig_exporter_24_store');
          for (const value of [
            { id: 'old', type: 'followers', src: { username: 'Alice' }, updatedAt: 100 },
            { id: 'latest', type: 'followers', src: { username: 'alice' }, updatedAt: 200 },
            { id: 'other', type: 'followers', src: { username: 'alice_extra' }, updatedAt: 300 },
            { id: 'following', type: 'following', src: { username: 'alice' }, updatedAt: 400 },
          ]) store.put(value, value.id);
          tx.oncomplete = () => yes(); tx.onerror = () => no(tx.error);
        });
      } finally { db.close(); }
    });
    assert.equal(await resumeLatestFollowerTask(page, 'ALICE'), 'latest');
    assert.equal(await resumeLatestFollowerTask(page, 'nobody'), null);
  } finally { await context?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('extension history survives replacing the browser profile', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-portable-history-'));
  const extension = resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID);
  let context;
  const open = async (path: string) => chromium.launchPersistentContext(path, { executablePath: chromium.executablePath(), headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const first = await prepareRuntimeProfile('123', '-follow', root);
    context = await open(first.path);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/history.html`);
    await page.locator('table tbody').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((yes, no) => { const r = indexedDB.open('IGE24Store'); r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
      try { await new Promise<void>((yes, no) => { const tx = db.transaction('ig_exporter_24_store', 'readwrite'); tx.objectStore('ig_exporter_24_store').put({ id: 'portable', type: 'followers', src: { username: 'alice' }, updatedAt: 200 }, 'portable'); tx.oncomplete = () => yes(); tx.onerror = () => no(tx.error); }); } finally { db.close(); }
    });
    await context.close(); context = undefined;
    await first.saveAndRemove();
    const second = await prepareRuntimeProfile('123', '-follow', root);
    context = await open(second.path);
    const restored = await context.newPage();
    assert.equal(await resumeLatestFollowerTask(restored, 'alice'), 'portable');
    await context.close(); context = undefined;
    await second.saveAndRemove();
  } finally { await context?.close(); await rm(root, { recursive: true, force: true }); }
});
