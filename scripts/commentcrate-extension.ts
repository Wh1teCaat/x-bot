/** 定位用户本机已有的 CommentCrate 扩展包，不修改插件或站点权限。 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const extensionId = 'haaahmifcccbgagmopbhbkgabgblmcbl';

/** 根据扩展公钥确认加载后的 ID 与现有插件接口一致。 */
export function matchesCommentCrateKey(key: unknown): boolean {
  if (typeof key !== 'string' || !key) return false;
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('') === extensionId;
}

/** 验证指定扩展目录可加载且不会改变预期的扩展 ID。 */
async function validExtension(path: string): Promise<boolean> {
  try { const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); return matchesCommentCrateKey(manifest.key); }
  catch { return false; }
}

/** 优先使用显式路径；否则只读查找 Chrome for Testing 默认资料中的已有插件。 */
export async function resolveCommentCratePath(configured?: string, home = homedir()): Promise<string | null> {
  if (configured) {
    const path = resolve(configured);
    if (!await validExtension(path)) throw new Error('X_COMMENTCRATE_EXTENSION_PATH 不是预期的 CommentCrate 扩展目录');
    return path;
  }
  const root = join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing', 'Default', 'Extensions', extensionId);
  const versions = await readdir(root).catch(() => [] as string[]);
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const path = join(root, version);
    if (await validExtension(path)) return path;
  }
  return null;
}
