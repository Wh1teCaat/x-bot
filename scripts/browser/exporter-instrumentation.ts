/** 仅为自动化暴露 exporter24 自身的任务状态；不修改已校验的原始插件包。 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extensionIdFromKey } from './extension-packages.ts';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';

const marker = 'n.default=new class t{initLoad()';
const replacement = 'n.default=globalThis.__followerStore=new class t{initLoad()';
export function exposeFollowerStore(source: string): string {
  const begin = source.indexOf('799:function(');
  const index = source.indexOf(marker, begin);
  if (begin < 0 || index < 0 || source.indexOf(marker, index + marker.length) >= 0 || !source.slice(index, index + 80000).includes('fetchFollowList(')) {
    throw new Error('exporter24 版本与粉丝任务接口不兼容，请检查插件更新');
  }
  return source.slice(0, index) + replacement + source.slice(index + marker.length);
}
export async function prepareInstrumentedExporter(sourceDir: string, root = resolve('.data/instrumented-extensions')): Promise<string> {
  const manifest = await readFile(join(sourceDir, 'manifest.json'));
  if (extensionIdFromKey(JSON.parse(manifest.toString('utf8')).key) !== EXPORTER24_EXTENSION_ID) throw new Error('exporter24 安装包身份不匹配');
  const source = await readFile(join(sourceDir, 'js/index.js'), 'utf8');
  const modified = exposeFollowerStore(source);
  const digest = createHash('sha256').update(manifest).update(source).update('xbot-store-v1').digest('hex');
  const destination = join(root, digest);
  const index = join(destination, 'js/index.js');
  if (existsSync(index)) {
    if (await readFile(index, 'utf8') !== modified || extensionIdFromKey(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')).key) !== EXPORTER24_EXTENSION_ID) throw new Error('exporter24 运行副本校验失败');
    return destination;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = `${destination}.creating-${randomUUID()}`;
  try {
    await cp(sourceDir, temp, { recursive: true });
    await writeFile(join(temp, 'js/index.js'), modified);
    try { await rename(temp, destination); }
    catch (error) { if (!existsSync(index)) throw error; }
    if (await readFile(index, 'utf8') !== modified) throw new Error('exporter24 运行副本校验失败');
    return destination;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
