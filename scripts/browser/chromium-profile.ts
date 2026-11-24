/** 为 Playwright 的浏览器准备账号专属资料，保留原 Chrome 资料作为回退。 */
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function prepareChromiumProfile(account: string, suffix = '', root = resolve('.data')): Promise<string> {
  if (!/^\d{1,19}$/.test(account) || !['', '-follow'].includes(suffix)) throw new Error('浏览器账号资料名无效');
  const name = account + suffix;
  const source = join(root, 'browser-profiles', name);
  const destination = join(root, 'chromium-profiles', name);
  if (existsSync(destination)) return destination;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await lstat(join(source, 'SingletonLock')).then(() => true, () => false)) throw new Error('原账号 Chrome 资料仍有锁，迁移前请关闭浏览器并检查锁状态');
  const temporary = `${destination}.creating-${randomUUID()}`;
  try {
    if (existsSync(source)) {
      const excluded = new Set(['Default/Preferences', 'Default/Secure Preferences', 'Default/Extensions', 'Default/Extension State', 'Default/Extension Rules', 'Default/Extension Scripts']);
      await cp(source, temporary, { recursive: true, verbatimSymlinks: true, filter: path => {
        const relative = path.slice(source.length + 1);
        return !excluded.has(relative) && !['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].includes(basename(path));
      } });
    } else await mkdir(temporary, { recursive: true, mode: 0o700 });
    try { await rename(temporary, destination); }
    catch (error) { if (!existsSync(destination)) throw error; await rm(temporary, { recursive: true, force: true }); }
    return destination;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
