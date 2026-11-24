import '../../src/runtime-config.ts';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../../src/account-store.ts';
import { BitBrowserClient } from './bitbrowser-client.ts';
import { loadCookieJar, findCookieFile } from './cookies.ts';
import { COMMENTCRATE_EXTENSION_ID } from './extension-packages.ts';
import { ensureCommentCratePermission } from './commentcrate-permission.ts';
import { EXPORTER24_EXTENSION_ID, ensureExporter24Auth } from './exporter24.ts';
import { prepareInstrumentedExporter } from './exporter-instrumentation.ts';
import { attachFollowerStore, resumeLatestFollowerTask } from './follower-batch.ts';
import { readExporterHistory, writeExporterHistory } from './bitbrowser-history-transfer.ts';

const [accountId, windowId, apiUrl] = process.argv.slice(2);
if (!/^\d{1,19}$/.test(accountId || '') || !windowId || !apiUrl) throw new Error('用法：node scripts/browser/bitbrowser-migration-test.ts <账号ID> <空白测试窗口ID> <本地API地址>');
const accounts = new AccountStore(resolve('.data'));
let account: ReturnType<AccountStore['getByUuid']>;
try { account = accounts.getByUuid(accountId); } finally { accounts.close(); }
if (!account?.username) throw new Error('账号信息不完整');
const db = new DatabaseSync('.data/loop.sqlite');
let checkpoint: { taskId: string; offset: number } | undefined;
try {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='follower_checkpoints'").get();
  const row = hasTable && account.copiedFromUsername ? db.prepare('SELECT task_id,offset FROM follower_checkpoints WHERE account=? AND blogger=?').get(accountId, account.copiedFromUsername.toLowerCase()) as { task_id: string; offset: number } | undefined : undefined;
  if (row?.task_id) checkpoint = { taskId: row.task_id, offset: Number(row.offset) };
} finally { db.close(); }
const cookiePath = await findCookieFile(accountId);
if (!cookiePath) throw new Error('账号缺少 Cookie 文件');
const client = new BitBrowserClient(apiUrl);
await client.health();
if (!await client.isolated(windowId)) throw new Error('测试窗口未关闭 Cookie 或扩展数据同步，停止迁移');
if (await client.isOpen(windowId)) throw new Error('测试窗口已打开，请先关闭以确保加载指定插件');
const root = await mkdtemp(join(tmpdir(), 'xbot-bit-migration-'));
let source: BrowserContext | undefined, target: Browser | undefined, opened = false;
try {
  const historyDir = resolve('.data/account-data', accountId, 'exporter-follow');
  const sourceProfile = join(root, 'source');
  await mkdir(join(sourceProfile, 'Default/IndexedDB'), { recursive: true, mode: 0o700 });
  for (const ext of ['leveldb', 'blob']) {
    const name = `chrome-extension_${EXPORTER24_EXTENSION_ID}_0.indexeddb.${ext}`;
    try { await cp(join(historyDir, name), join(sourceProfile, 'Default/IndexedDB', name), { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ext === 'leveldb') throw error; }
  }
  const exporter = await prepareInstrumentedExporter(resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID));
  const crate = resolve('.data/extension-packages', COMMENTCRATE_EXTENSION_ID);
  const chrome = chromium.executablePath().replace(join(homedir(), 'Library/Caches/ms-playwright'), resolve('.data/playwright-browsers'));
  source = await chromium.launchPersistentContext(sourceProfile, { executablePath: chrome, headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${exporter}`, `--load-extension=${exporter}`] });
  const sourcePage = await source.newPage();
  const latest = account.copiedFromUsername ? await resumeLatestFollowerTask(sourcePage, account.copiedFromUsername) : null;
  const snapshot = await readExporterHistory(sourcePage);
  const tasks = snapshot.stores.ig_exporter_24_store;
  const task = latest ? tasks.find(entry => (entry.value as any)?.id === latest)?.value as any : null;
  if (latest && !task) throw new Error('源历史任务不完整，未导入');
  console.log(latest ? `源历史已验证：任务 ${latest}，已保存 ${Number(task.storage?.totalFetched || 0)} 人。` : '源历史已读取；当前博主没有可续抓的历史任务。');
  await source.close(); source = undefined;

  const openedWindow = await client.open(windowId, [crate, exporter]); opened = true;
  target = await chromium.connectOverCDP(openedWindow.ws, { timeout: 30000 });
  const context = target.contexts()[0];
  if (!context) throw new Error('比特窗口没有可用浏览器上下文');
  const jar = await loadCookieJar(cookiePath);
  const currentCookies = await context.cookies(['https://x.com', 'https://twitter.com']);
  if (currentCookies.some(cookie => cookie.name === 'auth_token' && cookie.value !== jar.cookies.find(item => item.name === 'auth_token')?.value)) throw new Error('目标窗口已有其他账号登录，未写入历史或覆盖 Cookie');
  const exporterPage = await context.newPage();
  await exporterPage.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`, { timeout: 30000 });
  try { await writeExporterHistory(exporterPage, snapshot); }
  catch (error) {
    // 中断重试时，只接受与源完全一致的已导入快照，绝不覆盖已有数据。
    const current = await readExporterHistory(exporterPage).catch(() => null);
    if (!current || !serialize(current).equals(serialize(snapshot))) throw error;
  }
  const restored = await readExporterHistory(exporterPage);
  if (!serialize(restored).equals(serialize(snapshot))) throw new Error('迁移后历史内容校验不一致');
  console.log('历史任务及分页数据已写入测试窗口并校验。');

  const cratePage = await context.newPage();
  await cratePage.goto(`chrome-extension://${COMMENTCRATE_EXTENSION_ID}/popup/popup.html`, { timeout: 30000 });
  await ensureCommentCratePermission(cratePage, { label: '比特浏览器测试窗口' });
  console.log('CommentCrate X 访问权限已确认。');
  await cratePage.close();

  await context.addCookies(jar.cookies);
  const xPage = await context.newPage();
  await xPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const href = await xPage.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 15000 });
  if (href?.toLowerCase() !== `/${account.username.toLowerCase()}`) throw new Error('比特窗口的 X 登录账号与目标账号不一致或 Cookie 无效');
  console.log(`X Cookie 登录通过：@${account.username}。`);

  await exporterPage.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html`, { waitUntil: 'domcontentloaded' });
  await ensureExporter24Auth(exporterPage);
  const targetTask = account.copiedFromUsername ? await resumeLatestFollowerTask(exporterPage, account.copiedFromUsername) : null;
  if (targetTask !== latest) throw new Error('比特窗口的历史任务与源不一致');
  if (targetTask) {
  await exporterPage.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html?${new URLSearchParams({ taskId: targetTask, tab: 'follower' })}`);
  await attachFollowerStore(exporterPage);
  await exporterPage.waitForFunction(() => { const s = (globalThis as any).__followerStore; return Boolean(s?.task && !s.loading && s.profileChunkStore?.queryPage && s._chunkTaskId === s.task.id && Number(s.fetchedCount) === Number(s.task.storage?.totalFetched || 0)); }, undefined, { timeout: 30000 });
  const state = await exporterPage.evaluate(() => { const s = (globalThis as any).__followerStore; return { taskId: s.task.id, fetched: s.fetchedCount, running: Boolean(s.runningTaskId || s.isProcessing), more: Boolean(s.profileList.hasMore) }; });
  if (state.taskId !== targetTask || state.running) throw new Error('迁移后的任务状态异常');
  console.log(`比特窗口只读验证通过：粉丝历史 ${state.fetched} 人${checkpoint ? `，本地断点 ${checkpoint.offset}` : ''}，任务未启动，${state.more ? '存在后续页' : '无后续页'}。`);
  }
} finally {
  await source?.close().catch(() => {});
  // Browser.close() 会关闭 CDP 所属的远程浏览器；统一由比特本地 API 关闭。
  if (opened) await client.close(windowId).catch(() => console.error('测试窗口关闭失败，请在比特浏览器中手动关闭。'));
  await target?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
