import '../../src/runtime-config.ts';
import { monitorProcess } from '../../src/runtime-monitor.ts';
/** 前台登录账号并使用相同资料启动单轮任务。 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { accountReadiness } from '../account/account-readiness.ts';
import { cookieFileCandidates, defaultCookiePath, loadCookieJar, type CookieJar } from '../browser/cookies.ts';
import { fingerprintFor } from '../browser/fingerprint.ts';
import { AccountStore } from '../../src/account-store.ts';
import { DatabaseSync } from 'node:sqlite';
import { FollowerCheckpoints } from '../browser/follower-batch.ts';
import { XPageCircuit } from '../browser/x-page-circuit.ts';
import { acquireBrowserSlot, type BrowserSlotRelease } from '../browser/browser-slots.ts';
import { prepareRuntimeProfile } from '../browser/runtime-profile.ts';
import { downloadExtension } from '../browser/download-extension.ts';
import { findExtensionPackage, COMMENTCRATE_EXTENSION_ID } from '../browser/extension-packages.ts';
import { EXPORTER24_EXTENSION_ID } from '../browser/exporter24.ts';
import { ensureCommentCratePermission } from '../browser/commentcrate-permission.ts';
import { prepareInstrumentedExporter } from '../browser/exporter-instrumentation.ts';
import { ensureBitBinding } from '../browser/bitbrowser-binding.ts';

const args = process.argv.slice(2);
const accountId = args[0];
if (/^\d{1,19}$/.test(accountId || '')) {
  await ensureBitBinding(accountId);
  const child = spawn(process.execPath, ['scripts/loop/bitbrowser-login-and-run.ts', ...args], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
  const forwardStop = (signal: NodeJS.Signals) => { if (child.exitCode === null) child.kill(signal); };
  process.once('SIGINT', () => forwardStop('SIGINT'));
  process.once('SIGTERM', () => forwardStop('SIGTERM'));
  const code = await new Promise<number>(resolveCode => { child.once('error', () => resolveCode(1)); child.once('exit', code => resolveCode(code ?? 1)); });
  process.exit(code);
}
const telemetry = monitorProcess(accountId, 'login');
telemetry.stage('检查登录与浏览器');
const checkOnly = args.includes('--check-only');
const followerLoop = args.includes('--follower-loop');
const followerProfile = followerLoop || args.includes('--follower-profile');
const forwarded = args.slice(1).filter(argument => !['--check-only', '--follower-loop', '--follower-profile'].includes(argument));
const bloggerArgIndex = forwarded.indexOf('--blogger');
const followerBlogger = followerLoop && bloggerArgIndex >= 0 ? String(forwarded[bloggerArgIndex + 1] || '').replace(/^@/, '') : '';
if (followerLoop && !/^[A-Za-z0-9_]{1,15}$/.test(followerBlogger)) { console.error('--follower-loop 需要 --blogger <博主用户名>'); process.exit(1); }
if (!/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run loop -- <已授权账号数字ID> [--check-only] [--blogger <博主用户名>] [--language ar] [--evaluate]'); process.exit(1);
}
if (process.platform !== 'darwin') { console.error('目前只支持 macOS'); process.exit(1); }
const portText = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(portText) || +portText < 1 || +portText > 65535) { console.error('PORT 无效'); process.exit(1); }
const origin = `http://127.0.0.1:${portText}`;
const root = resolve('.data', 'browser-profiles');
const profileSuffix = followerProfile ? '-follow' : '';
let profile = join(root, accountId + profileSuffix);
const lockPath = join(root, `${accountId}${profileSuffix}.lock`);
const defaultBrowserRoot = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const bundledPath = chromium.executablePath();
const executable = process.env.X_BROWSER_EXECUTABLE || bundledPath.replace(defaultBrowserRoot, resolve('.data/playwright-browsers'));
let lockOwned = false, loginBrowser, context, worker, store;
let pageCircuit: XPageCircuit | undefined;
let releaseBrowserSlot: BrowserSlotRelease | undefined;
let runtimeProfile: Awaited<ReturnType<typeof prepareRuntimeProfile>> | undefined;
let contextClosing: Promise<void> | undefined;
let contextCloseFailed = false;
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
  if (context && !contextClosing) contextClosing = context.close().catch(() => { contextCloseFailed = true; });
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
  await access(executable, constants.X_OK).catch(() => { throw new Error('未安装 Playwright Chromium；请运行 PLAYWRIGHT_BROWSERS_PATH=.data/playwright-browsers npx playwright install --no-shell chromium'); });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await acquireLock();
  releaseBrowserSlot = await acquireBrowserSlot(accountId, { cancelled: () => stopping, onWait: () => console.log('五个浏览器槽位均忙，等待空闲槽位。') });
  runtimeProfile = await prepareRuntimeProfile(accountId, profileSuffix, resolve('.data'), releaseBrowserSlot.slot);
  profile = runtimeProfile.path;
  const source = process.env.X_PROFILE_TEMPLATE_SOURCE || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  const extensionPaths: string[] = [];
  for (const id of [COMMENTCRATE_EXTENSION_ID, EXPORTER24_EXTENSION_ID]) {
    try {
      const path = await downloadExtension(id);
      extensionPaths.push(id === EXPORTER24_EXTENSION_ID ? await prepareInstrumentedExporter(path) : path);
    }
    catch (error) {
      if (id !== COMMENTCRATE_EXTENSION_ID || !(error instanceof Error) || !/HTTP 204/.test(error.message)) throw error;
      const local = await findExtensionPackage(source, id);
      if (!local) throw error;
      console.warn(`扩展 ${id} 无法从商店下载，使用本机已验证的安装包：${error instanceof Error ? error.message : String(error)}`);
      extensionPaths.push(local);
    }
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  store = new AccountStore(resolve('.data'));
  const fp = fingerprintFor(accountId);
  const chromeReady = store.getByUuid(accountId)?.chromeReady ?? false;
  const needsCheck = true;
  // 用户配置 Cookie 时每次注入对应账号的 Cookie；其余情况复用资料登录态。
  let cookiePath: string | null = null;
  let cookieJar: CookieJar | null = null;
  {
    for (const candidate of cookieFileCandidates(accountId)) {
      try { await access(candidate, constants.R_OK); cookiePath = candidate; break; } catch {}
    }
  }
  if (cookiePath) {
    cookieJar = await loadCookieJar(cookiePath);
    for (const warning of cookieJar.warnings) console.warn(warning);
    console.log(`正在用 ${cookiePath} 中的 cookie 登录 @${username}，跳过手动登录窗口。`);
  }
  if (!cookieJar) {
    console.log(`正在打开 @${username} 的登录窗口，请登录 X。`);
    loginBrowser = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', 'https://x.com/home', `--lang=${fp.locale}`, `--window-size=${fp.viewport.width},${fp.viewport.height}`], { stdio: 'ignore' });
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
  } else if (chromeReady) {
    console.log(checkOnly
      ? `账号 @${username} 已标记为就绪，正在重新检查登录与插件……`
      : `账号 @${username} 已登录并安装插件，跳过登录与安装步骤。`);
  } else {
    console.log(`已读取 @${username} 的 cookie，接下来检查登录态与 CommentCrate。`);
  }
  const cdpPort = await allocatePort();
async function runFollowerLoop() {
  const db = new DatabaseSync(resolve('.data', 'loop.sqlite'));
  db.exec('PRAGMA busy_timeout=10000');
  const checkpoints = new FollowerCheckpoints(db);
  const sleep = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
  try {
    for (;;) {
      if (stopping) break;
      const checkpoint = checkpoints.get(accountId, followerBlogger);
      if (checkpoint.done) { console.log('粉丝已抓完，粉丝常驻 loop 退出。'); break; }
      if (checkpoint.due > Date.now()) {
        await sleep(Math.min(30000, Math.max(500, checkpoint.due - Date.now() + 300)));
        continue;
      }
      telemetry.stage('执行粉丝定时续抓');
      console.log('粉丝常驻 loop：开始抓取下一批。');
      const code = await new Promise<number>((resolveCode) => {
        const child = spawn(process.execPath, ['scripts/loop/run-loop.ts', '--account-id', accountId, '--username', username,
          '--cdp-port', String(cdpPort), '--followers-only', '--keep-browser', '--ignore-pending-followers', '--blogger', followerBlogger, '--yes'],
          { stdio: 'inherit', detached: true });
        worker = child;
        child.once('error', () => { worker = null; resolveCode(1); });
        child.once('exit', value => { worker = null; resolveCode(value ?? 1); });
      });
      telemetry.stage('等待粉丝批次', 'waiting');
      if (code !== 0) {
        const exporter = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='exporter_retry'").get();
        const manual = exporter && db.prepare("SELECT state FROM exporter_retry WHERE scope IN (?,?) AND state='manual' LIMIT 1").get(`exporter:${accountId}`, `exporter-open:${accountId}`) as { state?: string } | undefined;
        if (manual?.state === 'manual') { console.error('exporter24 需要人工检查，粉丝常驻流程已停止；断点保留。'); break; }
        console.error('粉丝本批失败，断点保留；60 秒后重试。'); if (!stopping) await sleep(60000);
      }
    }
  } finally { db.close(); }
}

  console.log(needsCheck
    ? '正在用 Playwright 打开该账号的浏览器资料并检查登录和插件……'
    : '正在用 Playwright 打开该账号的浏览器资料并执行任务……');
  const headless = /^(1|true|yes)$/i.test(process.env.X_HEADLESS || '');
  if (headless) console.log('X_HEADLESS=1：浏览器以无界面模式启动。');
  pageCircuit = new XPageCircuit();
  context = await chromium.launchPersistentContext(profile, {
    headless, executablePath: executable,
    // 正式版 Chrome 158 在 --no-sandbox 下会在启动约 15 秒后清除商店安装的扩展
    // （exporter24 / CommentCrate），因此必须保留 Chrome 沙箱。
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
    args: [`--remote-debugging-port=${cdpPort}`, '--no-first-run', `--disable-extensions-except=${extensionPaths.join(',')}`, `--load-extension=${extensionPaths.join(',')}`],
    locale: fp.locale, timezoneId: fp.timezoneId, viewport: fp.viewport, screen: fp.screen, colorScheme: fp.colorScheme,
    extraHTTPHeaders: { 'Accept-Language': fp.acceptLanguage },
  });
  pageCircuit.attach(context);
  const xBlockedAtStartup = pageCircuit.isBlocked();
  if (xBlockedAtStartup && checkOnly) throw new Error('X 页面熔断中，暂不能检查登录状态');
  if (xBlockedAtStartup) {
    console.log('X 页面熔断中，跳过启动时的页面读取，交由采集调度器执行冷却和恢复探测。');
  } else if (needsCheck) {
    if (cookieJar) await context.addCookies(cookieJar.cookies);
    const page = context.pages()[0] || await context.newPage();
    pageCircuit.guard(); await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    pageCircuit.guard();
    const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 10000 }).catch(() => null);
    const readiness = accountReadiness(href, username, false);
    if (readiness === 'login') {
      if (cookieJar) throw new Error(`cookie 无效或已过期（${cookiePath}），请从已登录 @${username} 的浏览器重新导出 auth_token 与 ct0；删除该文件则回到手动登录`);
      if (chromeReady) throw new Error(`账号 @${username} 的资料登录已失效；请更新 .data/cookies/${accountId}.json 后重试，保留浏览器资料以免丢失插件历史`);
      throw new Error(`请先在登录窗口登录 @${username} 后重试`);
    }
    if (readiness === 'wrong_account') throw new Error(`浏览器登录账号与 @${username} 不一致`);
    // 手工登录产生的 Cookie 单独保存在账号文件，后续浏览器实例均可导入。
    if (!cookieJar) {
      const cookies = (await context.cookies()).filter(cookie => /^(?:\.)?(?:x|twitter)\.com$/i.test(cookie.domain));
      if (!cookies.some(cookie => cookie.name === 'auth_token') || !cookies.some(cookie => cookie.name === 'ct0')) throw new Error('无法保存账号登录 Cookie');
      const path = defaultCookiePath(accountId), temporary = `${path}.tmp-${process.pid}`;
      await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ cookies }), { mode: 0o600 });
      await rename(temporary, path);
      console.log('账号登录 Cookie 已独立保存。');
    }
    if (!followerLoop && !forwarded.includes('--followers-only')) {
      const helper = await context.newPage();
      try {
        await helper.goto('chrome-extension://haaahmifcccbgagmopbhbkgabgblmcbl/popup/popup.html', { timeout: 5000 });
        await ensureCommentCratePermission(helper, { headless });
      } catch (error) {
        throw new Error(`CommentCrate 未就绪：${error.message}`);
      } finally { await helper.close().catch(() => {}); }
    }
    store.upsert({ uuid: accountId, username, chromeReady: true });
  } else {
    // 就绪账号不再走登录检查；先把初始 about:blank 打开成 X 主页，
    // 避免任务因限流冷却或立即失败时，窗口一直停在空白页。
    const blank = context.pages().find(page => page.url() === 'about:blank');
    pageCircuit.guard();
    if (blank) await blank.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(error => console.warn(`浏览器未能打开 X 主页：${error.message}`));
    pageCircuit.guard();
  }
  if (stopping) throw new Error('已取消');
  if (checkOnly) {
    console.log('登录与插件检查通过；--check-only 未执行任务，也未发送关注请求。');
  } else if (followerLoop) {
    console.log(`账号及插件检查通过；粉丝常驻 loop 启动（账号 @${username}，博主 @${followerBlogger}）。`);
    telemetry.stage('等待粉丝批次', 'waiting');
    await runFollowerLoop();
  } else {
    console.log('账号及插件检查通过，开始执行单轮任务；任务可能发送关注请求。');
    telemetry.stage('等待采集任务完成', 'waiting');
    worker = spawn(process.execPath, ['scripts/loop/run-loop.ts', '--account-id', accountId, '--username', username, '--cdp-port', String(cdpPort), ...forwarded], { stdio: 'inherit', detached: true });
    const code = await new Promise<number>((resolve, reject) => { worker.once('error', reject); worker.once('exit', value => resolve(value ?? 1)); });
    if (code !== 0) throw new Error(`单轮任务停止，退出码 ${code}`);
    console.log('单轮任务已完成。');
  }
} catch (error) {
  console.error(`启动或执行失败：${error.message}`); process.exitCode = 1;
} finally {
  stop();
  store?.close();
  await contextClosing;
  if (runtimeProfile && contextCloseFailed) {
    console.error('浏览器未确认关闭，运行资料已保留，插件历史未覆盖。');
    process.exitCode = 1;
  }
  if (runtimeProfile && !contextCloseFailed) {
    try { await runtimeProfile.saveAndRemove(); }
    catch (error) { console.error(`保存插件历史失败，运行资料已保留：${error.message}`); process.exitCode = 1; }
  }
  pageCircuit?.close();
  releaseBrowserSlot?.();
  if (lockOwned) await unlink(lockPath).catch(() => {});
}
