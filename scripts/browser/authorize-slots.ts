import '../../src/runtime-config.ts';
import { chromium, type BrowserContext } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { acquireBrowserSlot, type BrowserSlotRelease } from './browser-slots.ts';
import { acquireExporterLock } from './exporter-lock.ts';
import { downloadExtension } from './download-extension.ts';
import { COMMENTCRATE_EXTENSION_ID, findExtensionPackage } from './extension-packages.ts';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { ensureCommentCratePermission } from './commentcrate-permission.ts';
import { allSlotsAuthorized, markSlotAuthorized, slotAuthorizationReady } from './slot-authorization.ts';

const releases: BrowserSlotRelease[] = [];
let context: BrowserContext | undefined, stopping = false, unlock: (() => Promise<void>) | undefined;
const stop = () => { stopping = true; void context?.close().catch(() => {}); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (await allSlotsAuthorized()) {
    console.log('5 个浏览器空位已授权，跳过初始化。');
  } else {
    unlock = await acquireExporterLock({ lockPath: resolve('.data/browser-authorize.lock'), timeoutMs: 60 * 60_000, pollMs: 1000 });
    if (!await allSlotsAuthorized()) {
      const extensions: string[] = [];
      for (const id of [COMMENTCRATE_EXTENSION_ID, EXPORTER24_EXTENSION_ID]) {
        try { extensions.push(await downloadExtension(id)); }
        catch (error) {
          if (id !== COMMENTCRATE_EXTENSION_ID || !/HTTP 204/.test(String(error?.message || error))) throw error;
          const source = process.env.X_PROFILE_TEMPLATE_SOURCE || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
          const local = await findExtensionPackage(source, id);
          if (!local) throw error;
          extensions.push(local);
        }
      }
      console.log('正在准备浏览器授权；如有账号运行，请先在控制台停止。');
      for (let i = 0; i < 5; i++) releases.push(await acquireBrowserSlot('permission-setup', { cancelled: () => stopping, onWait: () => console.log('等待运行中的浏览器释放空位……') }));
      const executablePath = process.env.X_BROWSER_EXECUTABLE || chromium.executablePath().replace(join(homedir(), 'Library', 'Caches', 'ms-playwright'), resolve('.data/playwright-browsers'));
      for (const release of releases.sort((a, b) => a.slot - b.slot)) {
        if (stopping) throw new Error('授权已取消');
        if (await slotAuthorizationReady(release.slot)) { console.log(`浏览器空位 ${release.slot} 已授权，跳过。`); continue; }
        const profile = resolve('.data/browser-permission-slots', String(release.slot));
        await mkdir(profile, { recursive: true, mode: 0o700 });
        const open = async (headless: boolean) => {
          context = await chromium.launchPersistentContext(profile, { headless, executablePath, chromiumSandbox: true,
            ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
            args: ['--no-first-run', `--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`] });
          const page = context.pages()[0] || await context.newPage();
          await page.goto(`chrome-extension://${COMMENTCRATE_EXTENSION_ID}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await ensureCommentCratePermission(page, { headless, label: `浏览器空位 ${release.slot}` });
        };
        try {
          try { await open(true); }
          catch (error) {
            if (!/CommentCrate 缺少 X 站点权限/.test(String(error?.message || error)) || stopping) throw error;
            await context?.close(); context = undefined;
            console.log(`请授权浏览器空位 ${release.slot}；授权完成后窗口将自动关闭。`);
            await open(false);
          }
          await context?.close(); context = undefined;
          if (stopping) throw new Error('授权已取消');
          await markSlotAuthorized(release.slot);
          console.log(`浏览器空位 ${release.slot} 已授权并关闭。`);
        } finally { if (context) { await context.close().catch(() => {}); context = undefined; } }
      }
      console.log('5 个浏览器空位已授权。');
    }
  }
} catch (error) {
  console.error(`授权未完成：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  for (const release of releases) release();
  await unlock?.();
}
