/** 临时浏览器资料与账号插件历史分离；只保存 exporter24 的 IndexedDB。 */
import { cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';

const indexedDbNames = () => [`chrome-extension_${EXPORTER24_EXTENSION_ID}_0.indexeddb.leveldb`, `chrome-extension_${EXPORTER24_EXTENSION_ID}_0.indexeddb.blob`];
async function assertClosed(profile: string) {
  if (await lstat(join(profile, 'SingletonLock')).then(() => true, () => false)) throw new Error(`浏览器资料仍有 SingletonLock，请确认浏览器已关闭后检查：${profile}`);
}
async function copyHistory(profile: string, target: string) {
  const dir = join(profile, 'Default', 'IndexedDB');
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of indexedDbNames()) if (existsSync(join(dir, name))) await cp(join(dir, name), join(target, name), { recursive: true });
}
async function saveHistory(profile: string, history: string) {
  await assertClosed(profile);
  const parent = resolve(history, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${history}.new-${randomUUID()}`, backup = `${history}.previous-${randomUUID()}`;
  let moved = false;
  try {
    await copyHistory(profile, temp);
    await writeFile(join(temp, '.initialized'), '1', { mode: 0o600 });
    if (existsSync(history)) { await rename(history, backup); moved = true; }
    try { await rename(temp, history); }
    catch (error) { if (moved) await rename(backup, history); throw error; }
    if (moved) await rm(backup, { recursive: true, force: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function prepareRuntimeProfile(account: string, suffix = '', root = resolve('.data'), permissionSlot?: number) {
  if (!/^\d{1,19}$/.test(account) || !['', '-follow'].includes(suffix)) throw new Error('浏览器账号资料名无效');
  const name = account + suffix;
  const runtime = join(root, 'browser-runtime', name);
  const history = join(root, 'account-data', account, suffix ? 'exporter-follow' : 'exporter');
  // 进程可能在旧快照改名与新快照落盘之间退出，优先恢复旧快照。
  if (!existsSync(history)) {
    const parent = resolve(history, '..'), prefix = `${suffix ? 'exporter-follow' : 'exporter'}.previous-`;
    const candidates = (await readdir(parent).catch(() => [] as string[])).filter(name => name.startsWith(prefix));
    const dated = await Promise.all(candidates.map(async name => ({ name, time: (await stat(join(parent, name))).mtimeMs })));
    dated.sort((a, b) => b.time - a.time);
    if (dated[0]) await rename(join(parent, dated[0].name), history);
  }
  if (existsSync(runtime)) {
    // 上次异常退出后的运行目录是唯一可能包含新历史的地方，先保存再清理。
    if (existsSync(join(runtime, '.history-ready'))) await saveHistory(runtime, history);
    else await assertClosed(runtime);
    await rm(runtime, { recursive: true, force: true });
  }
  if (!existsSync(join(history, '.initialized'))) {
    const old = [join(root, 'chromium-profiles', name), join(root, 'browser-profiles', name)].find(path => existsSync(path));
    if (old) { await assertClosed(old); await saveHistory(old, history); }
  }
  await mkdir(join(runtime, 'Default', 'IndexedDB'), { recursive: true, mode: 0o700 });
  if (permissionSlot !== undefined) {
    if (!Number.isInteger(permissionSlot) || permissionSlot < 1 || permissionSlot > 5) throw new Error('浏览器权限空位无效');
    const template = join(root, 'browser-permission-slots', String(permissionSlot));
    // 模板仅供授权使用，从不加载账号 Cookie 或访问 X；只复制 Chrome 授权及扩展注册数据。
    for (const name of ['Local State', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Extension Scripts', 'Default/Extension Rules', 'Default/Extension State']) {
      if (existsSync(join(template, name))) await cp(join(template, name), join(runtime, name), { recursive: true });
    }
  }
  for (const name of indexedDbNames()) if (existsSync(join(history, name))) await cp(join(history, name), join(runtime, 'Default', 'IndexedDB', name), { recursive: true });
  await writeFile(join(runtime, '.history-ready'), '1', { mode: 0o600 });
  return { path: runtime, async saveAndRemove() { await saveHistory(runtime, history); await rm(runtime, { recursive: true, force: true }); } };
}
