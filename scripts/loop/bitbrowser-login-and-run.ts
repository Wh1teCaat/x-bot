import '../../src/runtime-config.ts';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { monitorProcess } from '../../src/runtime-monitor.ts';
import { AccountStore } from '../../src/account-store.ts';
import { BitBrowserClient } from '../browser/bitbrowser-client.ts';
import { getBitBinding, markBitAuthorized, setBitPreferredWindow } from '../browser/bitbrowser-binding.ts';
import { acquireBrowserSlot, type BrowserSlotRelease } from '../browser/browser-slots.ts';
import { findCookieFile, loadCookieJar } from '../browser/cookies.ts';
import { downloadExtension } from '../browser/download-extension.ts';
import { COMMENTCRATE_EXTENSION_ID } from '../browser/extension-packages.ts';
import { EXPORTER24_EXTENSION_ID, ensureExporter24Auth } from '../browser/exporter24.ts';
import { prepareInstrumentedExporter } from '../browser/exporter-instrumentation.ts';
import { ensureCommentCratePermission } from '../browser/commentcrate-permission.ts';
import { attachFollowerStore, FollowerCheckpoints, readFollowerBatch, resumeLatestFollowerTask, stopFollowerBatchForRetry } from '../browser/follower-batch.ts';
import { XPageCircuit } from '../browser/x-page-circuit.ts';
import { withExporterLock, withExporterRetryLock } from '../browser/exporter-lock.ts';
import { ExporterRetry } from '../browser/exporter-retry.ts';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { findBloggerPosts, getCollectorPage, scanAndExport } from '../replies/reply-export.ts';
import { readExporterHistory } from '../browser/bitbrowser-history-transfer.ts';
import { acquireBitWindow } from '../browser/bitbrowser-window-lease.ts';
import { prepareBitWindowAccount, saveBitWindowAccount } from '../browser/bitbrowser-window-state.ts';
import { sortPostsNewestFirst } from '../replies/post-order.ts';
import { browserFailureExitCode } from './follower-schedule-retry.ts';
import { parseLoopArguments } from './loop-arguments.ts';
import { acquireCollectionSlots } from './collection-slots.ts';

const args = process.argv.slice(2), accountId = args[0];
if (!/^\d{1,19}$/.test(accountId || '')) throw new Error('账号 ID 无效');
if (args.includes('--follower-loop')) throw new Error('比特浏览器暂不支持旧版粉丝常驻模式，请使用定时续抓');
const preferred = await getBitBinding(accountId);
if (!preferred) throw new Error('账号未绑定比特浏览器');
if (preferred.migrationPending) throw new Error('账号历史迁移尚未完成，请从控制台重新启动以继续迁移');
let binding = preferred;
const probeCollection = args.includes('--check-collection');
const checkOnly = args.includes('--check-only') || probeCollection;
const forwarded = args.slice(1).filter(arg => !['--check-only', '--check-collection', '--follower-profile', '--keep-browser'].includes(arg));
const telemetry = monitorProcess(accountId, 'login'); telemetry.stage('检查登录与比特浏览器');
const client = new BitBrowserClient(binding.apiUrl), locks: string[] = [];
let slot: BrowserSlotRelease | undefined, browser: Browser | undefined, context: BrowserContext | undefined, worker: ChildProcess | undefined;
let windowLease: Awaited<ReturnType<typeof acquireBitWindow>> | undefined;
let opened = false, stopping = false, pageCircuit: XPageCircuit | undefined;
let windowReady = false;
let releaseCollection: (() => void) | undefined;
async function lock(path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(path, 'wx', 0o600); locks.push(path); try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); } return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw error;
      const pid = (await readFile(path, 'utf8')).trim();
      if (!/^\d+$/.test(pid)) throw new Error('账号浏览器锁无效，请检查');
      try { process.kill(Number(pid), 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(path); continue; } throw e; }
      throw new Error('账号浏览器正在使用，请先停止该账号');
    }
  }
}
function stop() {
  stopping = true;
  if (worker?.pid && worker.exitCode === null) try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* 子进程可能已退出 */ }
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const origin = `http://127.0.0.1:${process.env.PORT || '3000'}`;
  const response = await fetch(`${origin}/api/accounts`, { headers: { 'X-Local-Request': '1' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`本地授权服务不可用（HTTP ${response.status}）`);
  const data = await response.json() as { accounts?: Array<{user?: {id?: string; username?: string}; scope?: string}> };
  const account = data.accounts?.find(item => item.user?.id === accountId), username = account?.user?.username;
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('未找到已授权账号');
  if (!['users.read', 'follows.write'].every(scope => (account.scope || '').split(/\s+/).includes(scope))) throw new Error('账号缺少读取或关注授权');
  const root = resolve('.data/browser-profiles'); await mkdir(root, { recursive: true, mode: 0o700 });
  await lock(resolve(root, `${accountId}.lock`)); await lock(resolve(root, `${accountId}-follow.lock`));
  if (!checkOnly) {
    const collection = parseLoopArguments(['--account-id', accountId, ...forwarded]);
    releaseCollection = await acquireCollectionSlots(collection, lane => {
      telemetry.stage(`等待${lane}采集槽位`, 'waiting');
      console.log(`${lane}采集槽位正在使用，本轮已排队。`);
    }, () => stopping);
  }
  telemetry.stage('检查登录与比特浏览器');
  slot = await acquireBrowserSlot(accountId, { cancelled: () => stopping, onWait: () => console.log('浏览器槽位已满，等待空闲。') });
  await client.health();
  windowLease = await acquireBitWindow(accountId, preferred.windowId, preferred.apiUrl, { cancelled: () => stopping, onWait: () => console.log('比特窗口均在使用，等待空闲。') });
  binding = { ...preferred, windowId: windowLease.windowId };
  if (binding.windowId !== preferred.windowId) console.log('原比特窗口不空闲，已分配其他空闲窗口。');
  if (!await client.isolated(binding.windowId)) throw new Error('比特浏览器窗口的数据同步设置不符合隔离要求');
  if (await client.isOpen(binding.windowId)) throw new Error('绑定的比特窗口正在使用，请先关闭');
  const crate = await downloadExtension(COMMENTCRATE_EXTENSION_ID);
  const exporter = await prepareInstrumentedExporter(await downloadExtension(EXPORTER24_EXTENSION_ID));
  const headless = !binding.needsAuthorization && binding.windowId === preferred.windowId && /^(1|true|yes)$/i.test(process.env.X_HEADLESS || '');
  console.log(`正在打开 @${username} 的比特浏览器${headless ? '（无界面）' : ''}。`);
  let openedWindow: Awaited<ReturnType<BitBrowserClient['open']>>;
  try { openedWindow = await client.open(binding.windowId, [crate, exporter], { headless }); opened = true; }
  catch (error) {
    // open 可能超时但浏览器已启动；只清理本进程独占且启动前确认空闲的窗口。
    try {
      if (await client.isOpen(binding.windowId)) {
        await client.close(binding.windowId);
        console.warn('已关闭启动接口失败后遗留的比特窗口。');
      }
    } catch { console.warn('未能确认或关闭启动失败的比特窗口，下次分配时会避开仍在运行的窗口。'); }
    throw error;
  }
  const port = Number(new URL(openedWindow.ws).port);
  browser = await chromium.connectOverCDP(openedWindow.ws, { timeout: 30000 });
  context = browser.contexts()[0]; if (!context) throw new Error('比特窗口没有浏览器上下文');
  pageCircuit = new XPageCircuit(); pageCircuit.attach(context);
  if (pageCircuit.isBlocked()) throw new Error('X 页面熔断中，请先检查限流状态');
  const cookiePath = await findCookieFile(accountId);
  if (!cookiePath) throw new Error('账号缺少 Cookie 文件');
  const jar = await loadCookieJar(cookiePath);
  const switched = await prepareBitWindowAccount(context, binding.windowId, accountId, jar.cookies.find(cookie => cookie.name === 'auth_token')?.value);
  windowReady = true;
  if (binding.needsAuthorization && !switched) {
    const existing = await context.cookies(['https://x.com', 'https://twitter.com']);
    const own = jar.cookies.find(cookie => cookie.name === 'auth_token')?.value;
    if (existing.some(cookie => cookie.name === 'auth_token' && cookie.value !== own)) throw new Error('预留窗口已有其他 X 登录，未覆盖 Cookie，请检查工作池');
    const ext = await context.newPage();
    try {
      await ext.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
      const hasHistory = await ext.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'IGE24Store'));
      if (hasHistory) {
        const history = await readExporterHistory(ext);
        if (['ig_exporter_24_store', 'ig_exporter_24_store_chunks', 'ig_exporter_24_store_comments'].some(name => history.stores[name]?.length)) throw new Error('预留窗口已有 exporter 历史，未覆盖，请检查工作池');
      }
    } finally { await ext.close().catch(() => {}); }
  }
  await context.addCookies(jar.cookies);
  const page = context.pages()[0] || await context.newPage();
  pageCircuit.guard(); await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }); pageCircuit.guard();
  const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 15000 }).catch(() => null);
  if (href?.toLowerCase() !== `/${username.toLowerCase()}`) throw new Error('X Cookie 已失效或账号不匹配');
  if (checkOnly || !forwarded.includes('--followers-only')) {
    const helper = await context.newPage();
    try { await helper.goto(`chrome-extension://${COMMENTCRATE_EXTENSION_ID}/popup/popup.html`, { timeout: 15000 }); await ensureCommentCratePermission(helper, { headless }); }
    finally { await helper.close().catch(() => {}); }
    if (binding.windowId !== preferred.windowId) await setBitPreferredWindow(accountId, preferred, binding.windowId, true);
    else if (preferred.needsAuthorization) await markBitAuthorized(accountId, preferred);
  } else if (binding.windowId !== preferred.windowId) {
    // 粉丝任务不检查 CommentCrate；下次使用该窗口时再检查权限。
    await setBitPreferredWindow(accountId, preferred, binding.windowId, false);
  }
  if (checkOnly) {
    const accountStore = new AccountStore(resolve('.data'));
    let blogger: string | null | undefined;
    try { blogger = accountStore.getByUuid(accountId)?.copiedFromUsername; } finally { accountStore.close(); }
    const historyDb = new DatabaseSync(resolve('.data/loop.sqlite'));
    let checkpoint;
    try { checkpoint = blogger ? new FollowerCheckpoints(historyDb).get(accountId, blogger) : null; } finally { historyDb.close(); }
    const extension = await context.newPage();
    try {
      await extension.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html`); await ensureExporter24Auth(extension);
      if (blogger && checkpoint?.taskId) {
        const latest = await resumeLatestFollowerTask(extension, blogger);
        if (!latest || latest !== checkpoint.taskId) {
          console.log(latest ? '找到其他历史任务，采集时将从该任务开头处理。' : '窗口没有该博主的 exporter 历史，采集时将从头抓取。');
        } else {
        await extension.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html?${new URLSearchParams({ taskId: latest, tab: 'follower' })}`);
        await attachFollowerStore(extension);
        await extension.waitForFunction(() => { const s = (globalThis as any).__followerStore; return !!s?.task && !s.loading && s._chunkTaskId === s.task.id && Number(s.fetchedCount) === Number(s.task.storage?.totalFetched || 0); }, undefined, { timeout: 30000 });
        const state = await extension.evaluate(() => { const s = (globalThis as any).__followerStore; return { count: s.fetchedCount, running: !!(s.runningTaskId || s.isProcessing) }; });
        if (state.running) throw new Error('比特窗口的粉丝任务仍在运行');
        if (state.count < checkpoint.offset) console.log(`exporter24 历史不足以恢复断点 ${checkpoint.offset}，采集时将从头抓取。`);
        else console.log(`exporter24 历史验证通过：${state.count} 人，断点 ${checkpoint.offset}，未启动采集。`);
        }
      }
    } finally { await extension.close().catch(() => {}); }
    console.log(`比特浏览器检查通过：@${username}、CommentCrate 和 exporter24；未执行关注或发送私信。`);
    if (probeCollection) {
      if (!blogger || !checkpoint?.taskId) throw new Error('缺少博主或粉丝断点，无法执行采集测试');
      process.env.XBOT_BIT_WINDOW_ID = binding.windowId; process.env.XBOT_BIT_API_URL = binding.apiUrl; process.env.XBOT_BIT_CDP_PORT = String(port);
      const verified = await connectTestingBrowser({ port, timeout: 30000 });
      const verifiedContext = verified.contexts()[0]; if (!verifiedContext) throw new Error('无法连接比特浏览器采集上下文');
      const guard = async () => {
        pageCircuit!.guard();
        if (await page.getByText(/sorry, you are rate limited|速率受限|请求过于频繁/i).first().isVisible().catch(() => false)) throw new Error('X 页面显示速率限制');
      };
      const posts = sortPostsNewestFirst((await findBloggerPosts(await getCollectorPage(verifiedContext), blogger, guard)).filter(post => typeof post.replies === 'number' && post.replies > 0));
      if (!posts.length) throw new Error('目标博主没有可用于测试的回复帖子');
      const temporary = await mkdtemp(join(tmpdir(), 'xbot-bit-replies-test-'));
      try {
        const result = await scanAndExport(await getCollectorPage(verifiedContext), posts[0], temporary, guard);
        console.log(`CommentCrate 实际导出测试通过：${result.count} 条回复；测试文件已清理，未筛选或关注。`);
      } finally { await rm(temporary, { recursive: true, force: true }); }
      const db = new DatabaseSync(resolve('.data/loop.sqlite'));
      try {
        const retry = new ExporterRetry(db, `exporter:${accountId}`);
        const retryState = retry.get();
        if (retryState?.state === 'manual') throw new Error('exporter24 处于人工检查状态，未启动测试抓取');
        if (retryState?.state === 'waiting' && retryState.next_at > Date.now()) throw new Error('exporter24 正在退避，未启动测试抓取');
        const extPage = await verifiedContext.newPage();
        try {
          await extPage.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html`);
          const result = await withExporterRetryLock(accountId, () => withExporterLock(async () => {
            try {
              return await readFollowerBatch(extPage, blogger, { ...checkpoint }, id => { if (id !== checkpoint.taskId) throw new Error('测试任务与保存断点不一致'); }, guard);
            } catch (error) {
              if (!await stopFollowerBatchForRetry(extPage)) retry.stop();
              throw error;
            }
          }));
          console.log(`exporter24 实际续抓测试通过：读取 ${result.candidates.length} 人，插件进度 ${result.nextOffset}；未筛选、未写入关注队列，本地断点仍为 ${checkpoint.offset}。`);
        } finally { await extPage.close().catch(() => {}); }
      } finally { db.close(); }
    }
  } else {
    if (stopping) throw new Error('任务已取消');
    telemetry.stage('等待采集任务完成', 'waiting');
    const env = { ...process.env, XBOT_COLLECTION_SLOT_OWNER: String(process.pid), XBOT_BIT_WINDOW_ID: binding.windowId, XBOT_BIT_API_URL: binding.apiUrl, XBOT_BIT_CDP_PORT: String(port) };
    const command = ['scripts/loop/run-loop.ts', '--account-id', accountId, '--username', username, '--cdp-port', String(port), '--keep-browser', ...forwarded];
    worker = spawn(process.execPath, command, { cwd: process.cwd(), env, stdio: 'inherit', detached: true });
    const code = await new Promise<number>(done => { worker!.once('error', () => done(1)); worker!.once('exit', code => done(code ?? 1)); });
    if (code !== 0) throw new Error(`单轮任务停止，退出码 ${code}`);
    console.log('比特浏览器单轮任务已完成。');
  }
} catch (error) {
  console.error(`比特浏览器启动或执行失败：${error instanceof Error ? error.message : String(error)}`);
  // 只有采集子进程尚未启动时，API 连接故障才可安全自动重试。
  process.exitCode = browserFailureExitCode(error, !!worker);
}
finally {
  stop(); pageCircuit?.close();
  if (opened) {
    if (windowReady && context) try { await saveBitWindowAccount(context, binding.windowId, accountId); } catch (error) { console.error(`保存 exporter 历史失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    try { await client.close(binding.windowId); } catch { console.error('比特窗口关闭接口失败，请在比特浏览器检查'); process.exitCode = 1; }
    await browser?.close().catch(() => {});
    try { if (await client.isOpen(binding.windowId)) { console.error('比特窗口仍在运行，请关闭后重试'); process.exitCode = 1; } } catch { process.exitCode = 1; }
  }
  slot?.();
  releaseCollection?.();
  await windowLease?.release();
  for (const path of locks.reverse()) await unlink(path).catch(() => {});
}
