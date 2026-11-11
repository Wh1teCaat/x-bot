/** 操作已创建的账号池位；不读取或写入浏览器登录凭证。 */
import 'dotenv/config';
import { sendAccountCommand, type AccountAction } from './account-socket.ts';

const [action, accountId] = process.argv.slice(2);
if (process.argv.length !== 4 || !['ready', 'run', 'status', 'stop'].includes(action) || !/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run account -- ready|run|status|stop <授权账号数字ID>'); process.exit(1);
}
try {
  const result = await sendAccountCommand(accountId, action as AccountAction);
  console.log(`${result.message}（${result.state}）`);
} catch (error) { console.error(`无法连接账号实例：${error.message}`); process.exitCode = 1; }
