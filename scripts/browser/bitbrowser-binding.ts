import { readFile, mkdir, rename, writeFile, cp } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { localBitBrowserOrigin } from './bitbrowser-client.ts';
import { acquireExporterLock } from './exporter-lock.ts';
import { findCookieFile } from './cookies.ts';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { spawn } from 'node:child_process';

export type BitBinding = { windowId: string; apiUrl: string; needsAuthorization?: boolean; migrationPending?: boolean };
function pathPresent(path: string) { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
/** 读取固定绑定；每个比特窗口只属于一个账号。 */
export async function getBitBinding(account: string, root = resolve('.data')): Promise<BitBinding | null> {
  let data: any;
  try { data = JSON.parse(await readFile(resolve(root, 'bitbrowser-bindings.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('比特浏览器账号绑定配置无法读取'); }
  if (data?.version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) throw new Error('比特浏览器账号绑定配置无效');
  const entry = data.accounts[account];
  if (!entry) return null;
  if (!/^\d{1,19}$/.test(account) || typeof entry.windowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.windowId) || typeof entry.apiUrl !== 'string') throw new Error('比特浏览器账号绑定无效');
  return { windowId: entry.windowId, apiUrl: localBitBrowserOrigin(entry.apiUrl), ...(entry.needsAuthorization === true ? { needsAuthorization: true } : {}), ...(entry.migrationPending === true ? { migrationPending: true } : {}) };
}

/** 首次使用时原子预留独立窗口；已有账号和窗口永不自动换绑。 */
export async function ensureBitBinding(account: string, root = resolve('.data'), cookiePath?: string): Promise<BitBinding> {
  if (!/^\d{1,19}$/.test(account)) throw new Error('账号 ID 无效');
  const existing = await getBitBinding(account, root);
  if (existing && !existing.migrationPending) return existing;
  if (!await findCookieFile(account, cookiePath)) throw new Error('账号尚未导入 X Cookie，请先导入后启动比特浏览器');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-bindings.lock') });
  try {
    const prior = await getBitBinding(account, root);
    if (prior?.migrationPending) return await migrateReserved(account, prior, root, cookiePath);
    if (prior) return prior;
    let registry: any;
    try { registry = JSON.parse(await readFile(resolve(root, 'bitbrowser-pool.json'), 'utf8')); }
    catch { throw new Error('比特浏览器工作池未准备，请先运行 npm run bitbrowser:pool -- prepare'); }
    const apiUrl = localBitBrowserOrigin(registry.origin);
    if (registry.version !== 1 || !Array.isArray(registry.slots) || registry.slots.some((slot: any) => !Number.isInteger(slot.number) || slot.number < 1 || slot.number > 6 || !/^[A-Za-z0-9_-]{1,128}$/.test(slot.id)) || new Set(registry.slots.map((slot: any) => slot.id)).size !== registry.slots.length) throw new Error('比特浏览器工作池配置无效');
    let data: any;
    try { data = JSON.parse(await readFile(resolve(root, 'bitbrowser-bindings.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; data = { version: 1, accounts: {} }; }
    if (data.version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) throw new Error('比特浏览器账号绑定配置无效');
    const used = new Set(Object.values(data.accounts).map((entry: any) => entry?.windowId));
    const available = registry.slots.slice().sort((a: any, b: any) => a.number - b.number).filter((entry: any) => entry.verified);
    const slot = available.find((entry: any) => !used.has(entry.id)) || available[0];
    if (!slot) throw new Error('没有已验证的比特浏览器窗口，请检查工作池');
    // 在允许首选窗口重复前，将旧绑定转换为窗口的最后使用者。
    const stateUnlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-window-state.lock') });
    try {
      const statePath = resolve(root, 'bitbrowser-window-owners.json');
      let state: any;
      try { state = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; state = { version: 1, windows: {} }; }
      if (state.version !== 1 || !state.windows || typeof state.windows !== 'object') throw new Error('比特窗口归属记录无效');
      for (const [id, old] of Object.entries(data.accounts) as [string, any][]) {
        if (!/^\d{1,19}$/.test(id) || !old?.windowId) throw new Error('比特浏览器账号绑定无效');
        if (!state.windows[old.windowId]) state.windows[old.windowId] = { owner: id };
      }
      const tmp = `${statePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(tmp, statePath);
    } finally { await stateUnlock(); }
    // 历史存在时不能悄悄换到空白窗口；须先通过迁移工具校验并导入。
    const historyRoot = resolve(root, 'account-data', account, 'exporter-follow');
    const name = `chrome-extension_${EXPORTER24_EXTENSION_ID}_0.indexeddb`;
    const history = resolve(historyRoot, `${name}.leveldb`);
    if (!existsSync(history)) {
      const legacy = resolve(root, 'browser-profiles', `${account}-follow`);
      const oldDb = resolve(legacy, 'Default', 'IndexedDB');
      if (existsSync(resolve(oldDb, `${name}.leveldb`))) {
        if (['', '-follow'].some(suffix => pathPresent(resolve(root, 'browser-profiles', `${account}${suffix}.lock`))) || pathPresent(resolve(legacy, 'SingletonLock'))) throw new Error('旧版账号浏览器可能正在使用，请关闭后再迁移粉丝历史');
        await mkdir(historyRoot, { recursive: true, mode: 0o700 });
        for (const ext of ['leveldb', 'blob']) {
          const source = resolve(oldDb, `${name}.${ext}`);
          if (existsSync(source)) await cp(source, resolve(historyRoot, `${name}.${ext}`), { recursive: true });
        }
      }
    }
    const entry: BitBinding = { windowId: slot.id, apiUrl, needsAuthorization: true, ...(existsSync(history) ? { migrationPending: true } : {}) };
    data.accounts[account] = entry;
    const path = resolve(root, 'bitbrowser-bindings.json'), tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, path);
    console.log(`账号 ${account} 已绑定比特浏览器空位 ${slot.number}。`);
    return entry.migrationPending ? await migrateReserved(account, entry, root, cookiePath) : entry;
  } finally { await unlock(); }
}

async function migrateReserved(account: string, binding: BitBinding, root: string, cookiePath?: string): Promise<BitBinding> {
  if (root !== resolve('.data')) throw new Error('该数据目录不能自动迁移历史');
  if (['', '-follow'].some(suffix => pathPresent(resolve(root, 'browser-profiles', `${account}${suffix}.lock`)))) throw new Error('账号浏览器可能正在使用，请先停止账号并检查锁文件');
  console.log('检测到旧版 exporter 历史，正在提取账号独立快照。');
  const child = spawn(process.execPath, ['scripts/browser/bitbrowser-snapshot-import.ts', account], { cwd: process.cwd(), env: { ...process.env, ...(cookiePath ? { X_COOKIE_FILE: resolve(cookiePath) } : {}) }, stdio: 'inherit' });
  const result = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('exit', code => done(code ?? 1)); });
  if (result) throw new Error('旧历史迁移未完成，窗口已保留给该账号，请检查日志后重试；原历史和断点未改动');
  const path = resolve(root, 'bitbrowser-bindings.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data.accounts?.[account]?.windowId !== binding.windowId) throw new Error('比特窗口绑定已改变');
  delete data.accounts[account].migrationPending;
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(tmp, path);
  return { windowId: binding.windowId, apiUrl: binding.apiUrl, needsAuthorization: true };
}

export async function markBitAuthorized(account: string, binding: BitBinding, root = resolve('.data')) {
  const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-bindings.lock') });
  try {
    const path = resolve(root, 'bitbrowser-bindings.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    const entry = data.accounts?.[account];
    if (!entry || entry.windowId !== binding.windowId || localBitBrowserOrigin(entry.apiUrl) !== binding.apiUrl) throw new Error('比特窗口绑定已改变');
    delete entry.needsAuthorization;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } finally { await unlock(); }
}

/** 记录最近成功使用的窗口；租约而非首选记录负责互斥。 */
export async function setBitPreferredWindow(account: string, original: BitBinding, windowId: string, authorized: boolean, root = resolve('.data')) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(windowId)) throw new Error('比特窗口 ID 无效');
  const unlock = await acquireExporterLock({ lockPath: resolve(root, 'bitbrowser-bindings.lock') });
  try {
    const path = resolve(root, 'bitbrowser-bindings.json'), data = JSON.parse(await readFile(path, 'utf8'));
    const entry = data.accounts?.[account];
    if (!entry || entry.windowId !== original.windowId || localBitBrowserOrigin(entry.apiUrl) !== original.apiUrl) throw new Error('比特窗口首选记录已改变');
    entry.windowId = windowId;
    if (authorized) delete entry.needsAuthorization; else entry.needsAuthorization = true;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(tmp, path);
  } finally { await unlock(); }
}
