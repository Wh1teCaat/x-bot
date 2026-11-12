/** 通过系统命令启动使用独立资料的正式版 Google Chrome。 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const portText = process.env.X_BOT_CDP_PORT || '9333';
if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error('X_BOT_CDP_PORT 必须是有效端口');
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('此启动方式目前只支持 macOS');
  process.exit(1);
}
const profile = resolve('.data', 'manual-chrome-profile');
const executable = process.env.X_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
try {
  await access(executable, constants.X_OK);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${Number(portText)}`, '--no-first-run', 'https://x.com/'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
  console.log(`Google Chrome 已启动，调试端口 ${portText}。请在此窗口登录 X 并安装 CommentCrate。关闭窗口或按 Ctrl+C 退出。`);
  const stop = () => browser.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await new Promise<number | null>(resolve => browser.once('exit', resolve));
  if (code) process.exitCode = code;
} catch (error) {
  console.error(`启动失败：${error.message}。请检查 Google Chrome 的安装路径及资料目录是否被占用。`);
  process.exitCode = 1;
}
