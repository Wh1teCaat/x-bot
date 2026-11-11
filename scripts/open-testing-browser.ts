/** 使用已有测试浏览器资料启动可供 Playwright 连接的窗口。 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { actionDelay } from './action-delay.ts';

const portText = process.env.X_BOT_CDP_PORT || '9333';
if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error('X_BOT_CDP_PORT 必须是有效端口');
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('此启动方式目前只配置了 macOS Chrome for Testing 资料目录');
  process.exit(1);
}
const profile = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome for Testing');
let context;
try {
  console.log('正在使用 Chrome for Testing 的现有资料启动浏览器。');
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: chromium.executablePath(),
    // Keep the existing profile's extensions and macOS Keychain-backed session usable.
    ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
    args: [`--remote-debugging-port=${Number(portText)}`],
  });
  let page = context.pages().find(p => /^https:\/\/x\.com(?:\/|$)/.test(p.url()));
  if (!page) {
    page = context.pages()[0] || await context.newPage();
    await actionDelay(page);
    await page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.bringToFront();
  console.log(`Chrome for Testing 已启动，调试端口 ${portText}。保持本进程运行；关闭浏览器窗口或按 Ctrl+C 退出。`);
  await new Promise(resolve => {
    context.on('close', resolve);
    process.once('SIGINT', () => { context.close().finally(resolve); });
    process.once('SIGTERM', () => { context.close().finally(resolve); });
  });
} catch (error) {
  console.error(`启动失败：${error.message.split('\n')[0]}。请检查该资料目录是否仍被其他 Chrome for Testing 窗口占用。`);
  process.exitCode = 1;
  if (context) await context.close().catch(() => {});
}
