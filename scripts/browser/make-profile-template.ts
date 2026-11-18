import '../../src/runtime-config.ts';
/** 从本机 Chrome 资料生成插件模板，供每个账号浏览器复制一份。 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProfileTemplate, PROFILE_TEMPLATE_DIR } from './profile-template.ts';

const source = process.env.X_PROFILE_TEMPLATE_SOURCE || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const destination = process.env.X_PROFILE_TEMPLATE || PROFILE_TEMPLATE_DIR;
try {
  await createProfileTemplate(resolve(source), destination);
  console.log(`插件模板已生成：${destination}`);
  console.log('新账号首次运行 npm run loop 时会自动复制该模板，并注入账号 cookie。');
} catch (error) {
  console.error(`生成插件模板失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
