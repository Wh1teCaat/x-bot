import '../../src/runtime-config.ts';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROFILE_TEMPLATE_DIR } from './profile-template.ts';
import { AccountStore } from '../../src/account-store.ts';

const accountId = process.argv[2];
if (process.argv.length !== 3 || !/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run profile:repair -- <账号数字ID>'); process.exit(1);
}
const root = resolve('.data', 'browser-profiles');
const profile = join(root, accountId);
const lock = join(root, `${accountId}.lock`);
const template = resolve(process.env.X_PROFILE_TEMPLATE || PROFILE_TEMPLATE_DIR);
let ownsLock = false, staging: string | undefined;
try {
  if (process.platform !== 'darwin') throw new Error('目前只支持 macOS');
  if (!existsSync(profile)) throw new Error('账号资料不存在；新账号启动时会自动复制模板');
  for (const path of ['Local State', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Extensions/haaahmifcccbgagmopbhbkgabgblmcbl'])
    if (!existsSync(join(template, path))) throw new Error(`插件模板不完整：缺少 ${path}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(lock, 'wx', 0o600);
  ownsLock = true;
  try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
  const processes = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  if (processes.split('\n').some(line => line.includes('--user-data-dir=') && line.includes(profile)))
    throw new Error('账号 Chrome 可能仍在运行，请先关闭该账号的浏览器');
  staging = await mkdtemp(join(root, `.${accountId}-template-`));
  await cp(template, staging, { recursive: true, force: true });
  const store = new AccountStore(resolve('.data'));
  try {
    const account = store.getByUuid(accountId);
    if (!account) throw new Error('未找到授权账号');
    store.upsert({ uuid: accountId, username: account.username, chromeReady: false });
  } finally { store.close(); }
  const backup = `${profile}.backup-${Date.now()}`;
  if (existsSync(backup)) throw new Error('备份路径已存在，请重试');
  await rename(profile, backup);
  try { await rename(staging, profile); staging = undefined; }
  catch (error) { await rename(backup, profile); throw error; }
  console.log(`原账号浏览器资料已保留：${backup}`);
  console.log('已从模板重建账号资料。请重新检查登录和插件；新资料不包含旧资料的登录状态。');
} catch (error) {
  console.error(`修复失败：${error.code === 'EEXIST' ? '账号锁已存在，请先停止账号任务并核实锁状态' : error.message}`);
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  if (ownsLock) await unlink(lock).catch(() => {});
}
