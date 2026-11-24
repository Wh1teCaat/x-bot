import '../../src/runtime-config.ts';
/** 验证并连接指定的 Google Chrome 调试端口。 */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BitBrowserClient } from './bitbrowser-client.ts';

const execFileAsync = promisify(execFile);
const chromePath = /(?:^|\/)Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/;

/** 仅接受项目安装的 Playwright 浏览器、显式配置的浏览器或正式版 Chrome。 */
function isAllowedBrowser(command: string): boolean {
  const bundledPath = chromium.executablePath();
  const projectPath = bundledPath.replace(join(homedir(), 'Library', 'Caches', 'ms-playwright'), resolve('.data/playwright-browsers'));
  const paths = [bundledPath, projectPath, process.env.X_BROWSER_EXECUTABLE].filter((path): path is string => Boolean(path));
  return chromePath.test(command) || paths.some(path => command === path || command.startsWith(path + ' '));
}

/** 验证端口只有一个监听进程且属于允许的浏览器。 */
export async function verifyTestingListener(port: number, run: (command: string, args: string[]) => Promise<{ stdout: string }> = execFileAsync, platform: NodeJS.Platform = process.platform, bit?: { pid: number; windowId: string }) {
  if (platform !== 'darwin') throw new Error('目前只能在 macOS 上验证 Google Chrome 的调试端口');
  let listeners: string[];
  try { listeners = (await run('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).stdout.trim().split(/\s+/).filter(Boolean); }
  catch { throw new Error(`无法确认端口 ${port} 的监听进程，请检查 Google Chrome 的远程调试设置`); }
  const pids = [...new Set(listeners)];
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) throw new Error(`端口 ${port} 没有唯一的浏览器监听进程`);
  const command = (await run('/bin/ps', ['-p', pids[0], '-o', 'command='])).stdout.trim();
  const bitAllowed = bit && Number(pids[0]) === bit.pid && /\/BitBrowser\.app\/Contents\/MacOS\/BitBrowser(?:\s|$)/.test(command) && command.includes(`/BitBrowser/BrowserCache/${bit.windowId} `);
  if (bit ? !bitAllowed : !isAllowedBrowser(command)) throw new Error(`端口 ${port} 不是允许的 Chrome、Playwright 或指定比特浏览器`);
  return Number(pids[0]);
}

/** 校验监听者并使用 CDP 连接测试浏览器。 */
export async function connectTestingBrowser({ timeout = 60000, port: requestedPort = undefined as number | undefined } = {}) {
  const portText = String(requestedPort ?? process.env.X_BOT_CDP_PORT ?? '9333');
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('X_BOT_CDP_PORT 必须是有效端口');
  const port = Number(portText);
  let bit: { pid: number; windowId: string } | undefined;
  if (process.env.XBOT_BIT_WINDOW_ID || process.env.XBOT_BIT_API_URL || process.env.XBOT_BIT_CDP_PORT) {
    const windowId = process.env.XBOT_BIT_WINDOW_ID, api = process.env.XBOT_BIT_API_URL;
    if (!windowId || !api || process.env.XBOT_BIT_CDP_PORT !== String(port)) throw new Error('比特浏览器连接参数不完整或端口不匹配');
    const pid = await new BitBrowserClient(api).pid(windowId);
    if (!pid) throw new Error('比特浏览器窗口未运行');
    bit = { pid, windowId };
  }
  const pid = await verifyTestingListener(port, execFileAsync, process.platform, bit);
  let browser;
  try {
    // A browser launched with --remote-debugging-port uses a per-session WebSocket ID.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: Math.min(timeout, 5000) });
  } catch {
    // Chrome's interactive remote-debugging UI also exposes this stable endpoint.
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/devtools/browser`, { timeout });
  }
  try {
    if (bit && await new BitBrowserClient(process.env.XBOT_BIT_API_URL!).pid(bit.windowId) !== bit.pid) throw new Error('比特浏览器窗口进程发生变化');
    if (await verifyTestingListener(port, execFileAsync, process.platform, bit) !== pid) throw new Error('调试端口监听进程在连接期间发生变化');
    return browser;
  } catch (error) { await browser.close().catch(() => {}); throw error; }
}
