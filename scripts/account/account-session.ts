/** 为一个账号维护持久工作池位，使用系统进程打开独立浏览器。 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink, chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { accountReadiness } from './account-readiness.ts';
import { AccountPoolSlot } from './account-pool.ts';
import { accountSocketPath } from './account-socket.ts';

const [accountId, username] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^\d{1,19}$/.test(accountId || '') || !/^[A-Za-z0-9_]{1,15}$/.test(username || '')) {
  console.error('用法：node scripts/account/account-session.ts <授权账号 ID> <用户名>'); process.exit(1);
}
if (process.platform !== 'darwin') { console.error('账号浏览器目前只支持 macOS'); process.exit(1); }
const root = join('.data', 'browser-profiles');
const profile = resolve(root, accountId);
const lockPath = join(root, `${accountId}.lock`);
const socketPath = accountSocketPath(accountId);
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(join('.data', 'account-sessions'), { recursive: true, mode: 0o700 });
let ownsLock = false, closing = false;
let browserProcess, worker;

/** 原子获取账号锁，避免同一资料目录同时启动多个实例。 */
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      await file.writeFile(String(process.pid)); await file.close(); ownsLock = true; return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const text = await readFile(lockPath, 'utf8');
      if (!/^\d+$/.test(text.trim())) throw new Error('账号锁内容无效，请检查锁文件');
      try { process.kill(Number(text), 0); throw new Error('该账号的浏览器实例已在运行'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await unlink(lockPath);
    }
  }
  throw new Error('无法获取账号浏览器锁');
}

/** 选择空闲本机端口；后续连接仍会校验实际监听进程。 */
async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('无法分配调试端口');
  return port;
}

/** 只在用户确认登录后连接浏览器，核验账号及插件授权。 */
async function checkBrowser(port: number): Promise<void> {
  const browser = await connectTestingBrowser({ port, timeout: 10000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('未找到浏览器上下文');
    const page = context.pages().find(p => /^https:\/\/x\.com(?:\/|$)/.test(p.url()));
    if (!page) throw new Error('请在该浏览器打开 X 并登录');
    const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 5000 }).catch(() => null);
    const status = accountReadiness(href, username, false);
    if (status === 'login') throw new Error(`请先登录 @${username}`);
    if (status === 'wrong_account') throw new Error(`浏览器登录账号与 @${username} 不一致`);
    const helper = await context.newPage();
    try {
      await helper.goto('chrome-extension://haaahmifcccbgagmopbhbkgabgblmcbl/popup/popup.html', { timeout: 5000 });
      const granted = await helper.evaluate(async () => {
        const api = (globalThis as any).chrome, crate = (globalThis as any).CommentCrate;
        const platform = crate?.platformsMeta?.PLATFORMS?.find(p => p.id === 'x');
        return !!platform && await crate.permissions.create(api).has(platform);
      });
      if (!granted) throw new Error('请授予 CommentCrate 对 X 的访问权限');
    } catch (error) {
      throw new Error(`CommentCrate 未就绪：${error.message}`);
    } finally { await helper.close().catch(() => {}); }
  } finally { await browser.close().catch(() => {}); }
}

/** 停止当前账号的整个任务进程组，避免遗留子任务。 */
function stopWorker() {
  if (!worker?.pid || worker.exitCode !== null) return;
  try { process.kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(`停止任务失败：${error.message}`); }
}

let pool: AccountPoolSlot;
const ipc = createServer(socket => {
  let buffer = '';
  socket.setTimeout(3000, () => socket.destroy());
  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 4096) { socket.destroy(); return; }
    if (!buffer.includes('\n')) return;
    try {
      const { action, username: requestedUser } = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      let message: string, shouldStop = false;
      if (requestedUser && requestedUser.toLowerCase() !== username.toLowerCase()) message = '账号用户名已变化，请停止旧实例后重新授权。';
      else if (action === 'status') message = `当前状态：${pool.state}${pool.lastError ? `；上次错误：${pool.lastError}` : ''}`;
      else if (action === 'ready') message = pool.ready();
      else if (action === 'run') message = pool.run();
      else if (action === 'stop') { pool.stop(); message = '正在关闭账号实例。'; shouldStop = true; }
      else message = '未知命令。';
      socket.end(JSON.stringify({ state: pool.state, message }) + '\n');
      if (shouldStop) setImmediate(() => shutdown());
    } catch { socket.end(JSON.stringify({ state: pool.state, message: '命令无效。' }) + '\n'); }
  });
});

/** 关闭池位及浏览器，但保留资料目录以复用登录和插件权限。 */
function shutdown() {
  if (closing) return;
  closing = true; pool?.stop(); stopWorker();
  if (browserProcess?.exitCode === null) browserProcess.kill('SIGTERM');
  if (ipc.listening) ipc.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

try {
  await acquireLock();
  await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const port = await allocatePort();
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // 不使用 Playwright 启动：直接执行 Chrome 命令，用户自行完成登录。
  const executable = process.env.X_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executable, constants.X_OK);
  browserProcess = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--no-first-run', 'https://x.com/home'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { browserProcess.once('spawn', resolve); browserProcess.once('error', reject); });
  browserProcess.once('exit', () => shutdown());
  pool = new AccountPoolSlot({
    check: () => checkBrowser(port),
    run: () => new Promise<void>((resolve, reject) => {
      worker = spawn(process.execPath, ['scripts/loop/run-loop.ts', '--account-id', accountId, '--username', username, '--cdp-port', String(port)], { stdio: 'inherit', detached: true });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`单轮任务停止，退出码 ${code ?? 'signal'}`)));
    }),
    report: message => console.error(message),
  });
  if (closing) throw new Error('浏览器已提前退出');
  await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  console.log(`已用 Chrome 命令启动 @${username} 的独立浏览器。请手动登录并授权插件，然后运行：npm run account:ready -- ${accountId}`);
  await new Promise<void>(resolve => ipc.once('close', resolve));
} catch (error) {
  console.error(`账号浏览器实例停止：${error.message}`); process.exitCode = 1;
} finally {
  shutdown();
  if (ownsLock) {
    await unlink(socketPath).catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
