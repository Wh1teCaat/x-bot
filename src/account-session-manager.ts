/** 在授权成功后启动账号专属浏览器任务；令牌不经过命令行或日志。 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { sendAccountCommand } from '../scripts/account-socket.ts';

type AuthenticatedUser = { id: string; username: string };

/** 校验授权身份并构造进程参数，避免将令牌或任意路径交给子进程。 */
export function accountSessionArguments(user: AuthenticatedUser): string[] {
  if (!/^\d{1,19}$/.test(user.id) || !/^[A-Za-z0-9_]{1,15}$/.test(user.username)) throw new Error('授权账号信息无效');
  return ['scripts/account-session.ts', user.id, user.username];
}

/** 测试环境或用户关闭自动启动时，不因 OAuth 回调启动浏览器。 */
export function shouldAutoStartAccountSession(scope: string, { nodeEnv, setting }: { nodeEnv?: string; setting?: string }): boolean {
  const granted = new Set(scope.split(/\s+/));
  return nodeEnv !== 'test' && setting !== 'false' && granted.has('users.read') && granted.has('follows.write');
}

/** 启动独立的账号会话；账号锁由会话进程持有并负责清理。 */
export async function startAccountSession(user: AuthenticatedUser) {
  const args = accountSessionArguments(user);
  // 同一账号已拥有工作池位时优先复用，不复用其他账号的登录状态。
  try { return await sendAccountCommand(user.id, 'run', user.username); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  const dir = join('.data', 'account-sessions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, `${user.id}.log`), 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, {
      detached: true, stdio: ['ignore', fd, fd],
    });
    child.on('error', error => console.error(`启动账号会话失败：${error.message}`));
    child.unref();
    return { state: 'starting', message: `已启动实例 ${child.pid}，请先人工登录。` };
  } finally { closeSync(fd); }
}
