/** 读取本机已安装的扩展程序包，校验公钥，供 Playwright 隔离加载。 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';

export const COMMENTCRATE_EXTENSION_ID = 'haaahmifcccbgagmopbhbkgabgblmcbl';
export function extensionIdFromKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key) return null;
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(char => 'abcdefghijklmnop'[parseInt(char, 16)]).join('');
}

export async function findExtensionPackage(root: string, id: string): Promise<string | null> {
  const dir = join(root, 'Default', 'Extensions', id);
  const versions = await readdir(dir).catch(() => [] as string[]);
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const path = join(dir, version);
    try {
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
      if (extensionIdFromKey(manifest.key) === id) return path;
    } catch { /* 尝试其他版本 */ }
  }
  return null;
}

export async function resolveExtensionPackages(source = process.env.X_PROFILE_TEMPLATE_SOURCE || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')): Promise<string[]> {
  const paths: string[] = [];
  for (const id of [COMMENTCRATE_EXTENSION_ID, EXPORTER24_EXTENSION_ID]) {
    const path = await findExtensionPackage(resolve(source), id);
    if (!path) throw new Error(`找不到有效的扩展 ${id}；请先在源 Chrome 中安装并启用`);
    paths.push(path);
  }
  return paths;
}
