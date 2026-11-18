import '../../src/runtime-config.ts';
/** 自动挑选一个仍能登录的 cookie 账号并执行单轮 loop。 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AccountStore } from '../../src/account-store.ts';
import { selectCookieAccounts } from './auto-select.ts';

const rawArgs = process.argv.slice(2);
const forwarded: string[] = [];
for (let index = 0; index < rawArgs.length; index++) {
  const key = rawArgs[index];
  if (key === '--evaluate') { forwarded.push(key); continue; }
  if (key === '--yes') { forwarded.push(key); continue; }
  const value = rawArgs[++index];
  if (!value) throw new Error(`参数 ${key} 缺少值`);
  if (key === '--blogger') {
    const name = value.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) throw new Error('博主用户名无效');
    forwarded.push(key, name);
  } else if (key === '--language') {
    if (value !== 'ar') throw new Error('目前仅支持 --language ar');
    forwarded.push(key, value);
  } else {
    throw new Error(`不支持的参数 ${key}`);
  }
}

const dataDir = resolve('.data');
const store = new AccountStore(dataDir);
const hasCookie = (accountId: string) =>
  existsSync(join(dataDir, 'cookies', `${accountId}.json`)) ||
  existsSync(join(dataDir, 'cookies', `${accountId}.txt`));
const candidates = selectCookieAccounts(store.list(), hasCookie);
store.close();
if (!candidates.length) {
  console.error('没有可用的 cookie 账号；请先在 /cookies 页面导入，或把文件放到 .data/cookies/<账号ID>.json。');
  process.exit(1);
}

const run = (args: string[]) => new Promise<number>((resolveCode, reject) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() });
  child.once('error', reject);
  child.once('exit', (code) => resolveCode(code ?? 1));
});

for (const account of candidates) {
  const id = account.uuid!;
  console.log(`\n检查账号 @${account.username}（${id}）...`);
  const checked = await run(['scripts/loop/login-and-run.ts', id, '--check-only']);
  if (checked !== 0) {
    console.log(`账号 @${account.username} 检查失败，尝试下一个。`);
    continue;
  }
  console.log(`使用 @${account.username} 执行单轮任务...`);
  const code = await run(['scripts/loop/login-and-run.ts', id, ...forwarded]);
  if (code !== 0) {
    console.error(`账号 @${account.username} 执行失败；已停止，避免重复操作。`);
    process.exitCode = 1;
  }
  process.exit();
}
console.error('所有 cookie 账号都未能通过检查。');
process.exit(1);
