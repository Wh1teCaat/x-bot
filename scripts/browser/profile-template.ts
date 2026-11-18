import '../../src/runtime-config.ts';
/** 从已安装插件的 Chrome 资料生成最小模板，并为每个账号复制一份隔离资料。 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROFILE_TEMPLATE_DIR = resolve('.data', 'profile-template');
const TEMPLATE_FILES = ['Local State', 'Default/Preferences', 'Default/Secure Preferences'];
const TEMPLATE_DIRS = [
  'Default/Extensions',
  'Default/Local Extension Settings',
  'Default/Extension State',
  'Default/Extension Rules',
  'Default/Extension Scripts',
];

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
