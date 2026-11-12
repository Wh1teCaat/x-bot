/** 前台登录账号并使用相同资料启动单轮任务。 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { accountReadiness } from './account-readiness.ts';

const accountId = process.argv[2];
if (process.argv.length !== 3 || !/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run loop -- <已授权账号数字ID>'); process.exit(1);
}
if (process.platform !== 'darwin') { console.error('目前只支持 macOS'); process.exit(1); }
const portText = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(portText) || +portText < 1 || +portText > 65535) { console.error('PORT 无效'); process.exit(1); }
const origin = `http://127.0.0.1:${portText}`;
const root = resolve('.data', 'browser-profiles');
const profile = join(root, accountId);
const lockPath = join(root, `${accountId}.lock`);
const executable = process.env.X_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let lockOwned = false, loginBrowser, context, worker;
let stopping = false;

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      lockOwned = true;
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pidText = (await readFile(lockPath, 'utf8')).trim();
      if (!/^\d+$/.test(pidText)) throw new Error('账号锁内容无效，请检查锁文件');
      try { process.kill(Number(pidText), 0); throw new Error(`账号实例已运行，请先执行 npm run account -- stop ${accountId}`); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await unlink(lockPath);
    }
  }
  throw new Error('无法获取账号锁');
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('无法分配调试端口');
  return port;
}

function stop() {
  stopping = true;
  if (worker?.pid && worker.exitCode === null) {
    try { process.kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  if (loginBrowser?.exitCode === null) loginBrowser.kill('SIGTERM');
  void context?.close().catch(() => {});
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  let response;
  try { response = await fetch(`${origin}/api/accounts`, { headers: { 'X-Local-Request': '1' }, signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error(`无法连接本地授权服务 ${origin}，请在另一个终端运行 npm start`); }
  if (!response.ok) throw new Error(`无法读取授权账号（HTTP ${response.status}）`);
  const data = await response.json() as { accounts?: Array<{ user?: { id?: string; username?: string }; scope?: string }> };
  const account = data.accounts?.find(item => item.user?.id === accountId);
  const username = account?.user?.username;
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error(`未找到账号 ${accountId}，请先在 ${origin} 完成 X 授权`);
  const scopes = (account.scope || '').split(/\s+/);
  if (!scopes.includes('users.read') || !scopes.includes('follows.write')) throw new Error('账号缺少读取或关注授权，请重新授权');
  await access(executable, constants.X_OK);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await acquireLock();
  await mkdir(profile, { recursive: true, mode: 0o700 });
  console.log(`正在打开 @${username} 的登录窗口，请登录 X 并安装、授权 CommentCrate。`);
  loginBrowser = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', 'https://x.com/home'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { loginBrowser.once('spawn', resolve); loginBrowser.once('error', reject); });
  const loginExit = new Promise<void>(resolve => loginBrowser.once('exit', () => resolve()));
  console.log('完成后请关闭该 Chrome 窗口；如关闭窗口后没有继续，请回到终端按 Enter。');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await Promise.race([loginExit, new Promise<void>(resolve => input.once('line', () => resolve()))]);
  } finally { input.close(); }
  if (stopping) throw new Error('已取消');
  if (loginBrowser.exitCode === null && loginBrowser.signalCode === null) {
    loginBrowser.kill('SIGTERM');
    await loginExit;
  }
  const cdpPort = await allocatePort();
  console.log('正在用 Playwright 打开该账号的浏览器资料并检查登录和插件……');
  context = await chromium.launchPersistentContext(profile, {
    headless: false, executablePath: executable,
    ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
    args: [`--remote-debugging-port=${cdpPort}`, '--no-first-run'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 10000 }).catch(() => null);
  const readiness = accountReadiness(href, username, false);
  if (readiness === 'login') throw new Error(`请先在登录窗口登录 @${username} 后重试`);
  if (readiness === 'wrong_account') throw new Error(`浏览器登录账号与 @${username} 不一致`);
  const helper = await context.newPage();
  try {
    await helper.goto('chrome-extension://haaahmifcccbgagmopbhbkgabgblmcbl/popup/popup.html', { timeout: 5000 });
    const granted = await helper.evaluate(async () => {
      const api = (globalThis as any).chrome, crate = (globalThis as any).CommentCrate;
      const platform = crate?.platformsMeta?.PLATFORMS?.find(p => p.id === 'x');
      return !!platform && await crate.permissions.create(api).has(platform);
    });
    if (!granted) throw new Error('请授予 CommentCrate 对 X 的访问权限');
  } catch (error) { throw new Error(`CommentCrate 未就绪：${error.message}`); }
  finally { await helper.close().catch(() => {}); }
  if (stopping) throw new Error('已取消');
  console.log('账号及插件检查通过，开始执行单轮任务；任务可能发送关注请求。');
  worker = spawn(process.execPath, ['scripts/run-loop.ts', '--account-id', accountId, '--username', username, '--cdp-port', String(cdpPort)], { stdio: 'inherit', detached: true });
  const code = await new Promise<number>((resolve, reject) => { worker.once('error', reject); worker.once('exit', value => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(`单轮任务停止，退出码 ${code}`);
  console.log('单轮任务已完成。');
} catch (error) {
  console.error(`启动或执行失败：${error.message}`); process.exitCode = 1;
} finally {
  stop();
  await context?.close().catch(() => {});
  if (lockOwned) await unlink(lockPath).catch(() => {});
}
