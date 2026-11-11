/** 使用本机 Unix socket 唤醒已创建的账号工作实例。 */
import { connect } from 'node:net';
import { resolve } from 'node:path';

export type AccountAction = 'ready' | 'run' | 'status' | 'stop';

/** 每个有效账号使用独立 socket，禁止路径穿越。 */
export function accountSocketPath(accountId: string): string {
  if (!/^\d{1,19}$/.test(accountId)) throw new Error('账号 ID 无效');
  return resolve('.data', 'account-sessions', `${accountId}.sock`);
}

/** 向现有池位发送一条命令；连接失败由调用者决定是否新建实例。 */
export async function sendAccountCommand(accountId: string, action: AccountAction, username?: string): Promise<{ state: string; message: string }> {
  return new Promise((resolveResult, reject) => {
    const socket = connect(accountSocketPath(accountId));
    let output = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('账号实例响应超时')));
    socket.once('connect', () => socket.write(JSON.stringify({ action, username }) + '\n'));
    socket.on('data', data => {
      output += data.toString();
      if (output.length > 4096) return socket.destroy(new Error('账号实例响应过长'));
      if (output.includes('\n')) {
        try { const result = JSON.parse(output.slice(0, output.indexOf('\n'))); socket.end(); resolveResult(result); }
        catch { socket.destroy(new Error('账号实例响应无效')); }
      }
    });
    socket.once('error', reject);
    socket.once('end', () => { if (!output.includes('\n')) reject(new Error('账号实例未返回结果')); });
  });
}
