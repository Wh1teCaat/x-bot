import '../../src/runtime-config.ts';
/** 从已安装插件的 Chrome 资料生成最小模板，并为每个账号复制一份隔离资料。 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, lstat, readlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';

export const PROFILE_TEMPLATE_DIR = resolve('.data', 'profile-template');
const TEMPLATE_FILES = ['Local State', 'Default/Preferences', 'Default/Secure Preferences'];
const TEMPLATE_DIRS = [
  'Default/Extensions',
  'Default/Local Extension Settings',
  'Default/Extension State',
  'Default/Extension Rules',
  'Default/Extension Scripts',
];
const COMMENTCRATE = 'haaahmifcccbgagmopbhbkgabgblmcbl';

async function hasExtension(root: string, id: string): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(join(root, 'Default/Secure Preferences'), 'utf8')).extensions.settings;
    const extension = settings[id];
    const extensions = resolve(root, 'Default/Extensions');
    const extensionPath = resolve(extensions, extension?.path || '');
    return !!extension && !extension.disable_reasons?.length && extensionPath.startsWith(extensions + '/') &&
      existsSync(join(extensionPath, 'manifest.json'));
  } catch { return false; }
}

/** 只清理本机已退出进程留下的 Chrome 锁，其他情况保守地视为占用。 */
async function assertProfileUnlocked(profileDir: string): Promise<void> {
  const lock = join(profileDir, 'SingletonLock');
  const info = await lstat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  const target = info.isSymbolicLink() ? await readlink(lock).catch(() => '') : '';
  const match = target.match(/^(.*)-(\d+)$/);
  let stale = false;
  if (match && match[1] === hostname() && Number(match[2]) > 0) {
    try { process.kill(Number(match[2]), 0); }
    catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  if (stale) {
    const current = await lstat(lock).catch(() => null);
    if (current && current.dev === info.dev && current.ino === info.ino && await readlink(lock).catch(() => '') === target) {
      await unlink(lock);
      return;
    }
  }
  throw new Error('账号 Chrome 资料存在 SingletonLock，请先关闭浏览器并检查锁状态');
}

/** 从本机已安装插件的 Chrome 复制受保护的插件配置；已有资料仅在插件缺失时修复。 */
export async function ensureProfileFromChrome(
  profileDir: string,
  source = process.env.X_PROFILE_TEMPLATE_SOURCE || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
): Promise<'created' | 'repaired' | null> {
  source = resolve(source);
  profileDir = resolve(profileDir);
  if (source === profileDir || source.startsWith(profileDir + '/') || profileDir.startsWith(source + '/'))
    throw new Error('源 Chrome 和账号资料目录不能相同或互相包含');
  if (!await hasExtension(source, COMMENTCRATE)) return null;
  const required = [COMMENTCRATE];
  if (await hasExtension(source, EXPORTER24_EXTENSION_ID)) required.push(EXPORTER24_EXTENSION_ID);
  if ((await Promise.all(required.map(id => hasExtension(profileDir, id)))).every(Boolean)) return null;
  // Chrome may reject copied protected registrations. Replacing them on every launch
  // would undo a user's attempt to repair the affected profile in Chrome itself.
  try {
    const prefs = JSON.parse(await readFile(join(profileDir, 'Default/Secure Preferences'), 'utf8'));
    const disabled = prefs.extensions?.settings?.[EXPORTER24_EXTENSION_ID]?.disable_reasons;
    if (Array.isArray(disabled) && disabled.length) {
      console.warn('账号资料中的 exporter24 已被 Chrome 禁用；请在该账号的 Chrome 扩展程序页面启用或从 Chrome 应用商店重新安装。');
      return null;
    }
  } catch { /* 资料尚未初始化时继续复制 */ }
  // Chrome 持有资料时不能修改其配置。
  await assertProfileUnlocked(profileDir);
  const entries = await readdir(profileDir).catch(() => [] as string[]);
  if (!entries.length) {
    await createProfileTemplate(source, profileDir);
    return 'created';
  }
  // 备份完整被替换部分，保留登录 cookie、历史及其他账号资料。
  const backup = await mkdtemp(join(dirname(profileDir), `${profileDir.split('/').pop()}.extensions-backup-`));
  const paths = ['Default/Secure Preferences', 'Default/Extensions'];
  const replaced: string[] = [];
  try {
    for (const path of paths) {
      const target = join(profileDir, path), input = join(source, path);
      if (!existsSync(input)) continue;
      if (existsSync(target)) {
        await mkdir(dirname(join(backup, path)), { recursive: true });
        await cp(target, join(backup, path), { recursive: true });
      }
      replaced.push(path);
      if (path === 'Default/Secure Preferences') await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await cp(input, target, { recursive: true });
    }
  } catch (error) {
    for (const path of replaced.reverse()) {
      const target = join(profileDir, path), original = join(backup, path);
      await rm(target, { recursive: true, force: true });
      if (existsSync(original)) await cp(original, target, { recursive: true });
    }
    throw error;
  }
  console.log(`原插件配置已备份：${backup}`);
  return 'repaired';
}

async function copyIfExists(source: string, destination: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  await cp(source, destination, { recursive: true, force: true });
  return true;
}

/** 从 Chrome 用户资料生成只含扩展与必要偏好的模板；不复制 cookie、历史或登录数据。 */
export async function createProfileTemplate(sourceProfile: string, destination = PROFILE_TEMPLATE_DIR): Promise<void> {
  if (!existsSync(join(sourceProfile, 'Local State'))) throw new Error('源资料缺少 Local State，可能不是 Chrome 用户资料目录');
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, 'Default'), { recursive: true, mode: 0o700 });
  for (const file of TEMPLATE_FILES) {
    if (!await copyIfExists(join(sourceProfile, file), join(destination, file)))
      throw new Error(`源资料缺少 ${file}`);
  }
  let copiedExtensions = false;
  for (const dir of TEMPLATE_DIRS) {
    if (await copyIfExists(join(sourceProfile, dir), join(destination, dir)) && dir === 'Default/Extensions')
      copiedExtensions = true;
  }
  if (!copiedExtensions) throw new Error('源资料没有 Default/Extensions，模板中没有可复制的插件');
}

/** 账号资料不存在或为空时，从模板复制一份；已存在则不动。 */
export async function ensureProfileFromTemplate(
  profileDir: string,
  templateDir = process.env.X_PROFILE_TEMPLATE || PROFILE_TEMPLATE_DIR,
): Promise<boolean> {
  if (!existsSync(templateDir)) return false;
  if (existsSync(profileDir)) {
    const entries = await readdir(profileDir).catch(() => []);
    if (entries.length) return false;
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await cp(templateDir, profileDir, { recursive: true, force: true });
  return true;
}
