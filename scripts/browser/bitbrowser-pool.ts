import '../../src/runtime-config.ts';
import { chromium } from 'playwright';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BitBrowserClient, localBitBrowserOrigin } from './bitbrowser-client.ts';
import { acquireExporterLock } from './exporter-lock.ts';
import { COMMENTCRATE_EXTENSION_ID, extensionIdFromKey } from './extension-packages.ts';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { prepareInstrumentedExporter } from './exporter-instrumentation.ts';

type Slot = { number: number; id: string; name: string; verified?: boolean };
type Registry = { version: 1; origin: string; slots: Slot[] };
const [command = 'prepare', arg] = process.argv.slice(2);
const origin = localBitBrowserOrigin(process.env.BITBROWSER_API_URL || 'http://127.0.0.1:54345');
const path = resolve('.data/bitbrowser-pool.json');
const client = new BitBrowserClient(origin);
async function load(): Promise<Registry> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Registry;
    if (value.version !== 1 || value.origin !== origin || !Array.isArray(value.slots) || value.slots.some(s => !Number.isInteger(s.number) || s.number < 1 || s.number > 6 || !/^[A-Za-z0-9_-]{1,128}$/.test(s.id) || !/^x-bot-pool-[a-z0-9-]{1,80}$/.test(s.name)) || new Set(value.slots.map(s => s.number)).size !== value.slots.length || new Set(value.slots.map(s => s.id)).size !== value.slots.length) throw new Error('工作池记录无效');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, origin, slots: [] }; throw error; }
}
async function save(registry: Registry) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
async function extensions() {
  const crate = resolve('.data/extension-packages', COMMENTCRATE_EXTENSION_ID);
  if (extensionIdFromKey(JSON.parse(await readFile(resolve(crate, 'manifest.json'), 'utf8')).key) !== COMMENTCRATE_EXTENSION_ID) throw new Error('CommentCrate 安装包身份不匹配');
  return [crate, await prepareInstrumentedExporter(resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID))];
}
async function verify(slot: Slot, paths: string[]) {
  if (!await client.isolated(slot.id)) throw new Error(`空位 ${slot.number} 的账号数据同步未关闭`);
  if (await client.isOpen(slot.id)) throw new Error(`空位 ${slot.number} 正在使用，请关闭后重试`);
  let opened = false, browser;
  try {
    const result = await client.open(slot.id, paths); opened = true;
    browser = await chromium.connectOverCDP(result.ws, { timeout: 30000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('缺少浏览器上下文');
    for (const [id, path] of [[COMMENTCRATE_EXTENSION_ID, 'popup/popup.html'], [EXPORTER24_EXTENSION_ID, 'index.html']]) {
      const page = await context.newPage();
      try {
        await page.goto(`chrome-extension://${id}/${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const loaded = await page.evaluate(() => (globalThis as any).chrome?.runtime?.id);
        if (loaded !== id) throw new Error(`扩展 ${id} 未加载`);
      } finally { await page.close().catch(() => {}); }
    }
  } finally {
    let closeError: unknown;
    if (opened) try { await client.close(slot.id); } catch (error) { closeError = error; }
    await browser?.close().catch(() => {});
    if (opened) {
      for (let attempt = 0; attempt < 3 && await client.isOpen(slot.id); attempt++) await new Promise(ok => setTimeout(ok, 1000));
      if (await client.isOpen(slot.id)) throw new Error(`空位 ${slot.number} 仍在运行，请在比特浏览器中关闭后重试`);
      if (closeError) console.warn(`空位 ${slot.number} 关闭接口曾报错，但已确认退出。`);
    }
  }
}

let unlock: (() => Promise<void>) | undefined;
try {
  await client.health();
  if (command === 'prepare') {
    unlock = await acquireExporterLock({ lockPath: resolve('.data/bitbrowser-pool.lock') });
    const registry = await load(), paths = await extensions();
    for (let number = 1; number <= 6; number++) {
      if (registry.slots.some(s => s.number === number)) continue;
      const name = `x-bot-pool-${number}`;
      const id = await client.createIsolatedWindow(name);
      registry.slots.push({ number, id, name });
      await save(registry);
      console.log(`已创建空位 ${number}。`);
    }
    for (const slot of registry.slots.sort((a, b) => a.number - b.number)) {
      if (slot.verified) continue;
      await verify(slot, paths);
      slot.verified = true; await save(registry);
      console.log(`空位 ${slot.number}：两个插件已验证可加载，窗口已关闭。`);
    }
    console.log('6 个独立窗口已准备。请使用本脚本打开，以加载对应插件。');
  } else if (command === 'open' || command === 'close') {
    const number = Number(arg), slot = (await load()).slots.find(item => item.number === number);
    if (!slot) throw new Error('无效或未创建的空位');
    if (command === 'close') {
      await client.close(slot.id);
      for (let attempt = 0; attempt < 3 && await client.isOpen(slot.id); attempt++) await new Promise(ok => setTimeout(ok, 1000));
      if (await client.isOpen(slot.id)) throw new Error(`空位 ${number} 仍在运行，请在比特浏览器中检查`);
      console.log(`空位 ${number} 已关闭。`);
    }
    else {
      if (!await client.isolated(slot.id)) throw new Error('该窗口的数据同步未关闭');
      if (await client.isOpen(slot.id)) throw new Error('该窗口已经打开');
      await client.open(slot.id, await extensions());
      console.log(`空位 ${number} 已打开并加载插件。`);
    }
  } else throw new Error('用法：npm run bitbrowser:pool -- prepare|open <1-6>|close <1-6>');
} catch (error) { console.error(`比特浏览器工作池操作失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
finally { await unlock?.(); }
