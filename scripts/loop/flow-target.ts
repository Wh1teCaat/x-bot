/** 统一流程的目标解析：已 clone 的账号只使用持久化目标，不再换目标。 */
import type { AccountRecord } from '../../src/account-store.ts';

export function resolveFlowTarget(record: AccountRecord, requested?: string): string {
  const target = requested?.trim().replace(/^@/, '');
  if (record.cloned) {
    if (!record.copiedFromUsername)
      throw new Error('账号已 clone，但账号表里没有目标用户名；请检查 copied_from_username');
    if (target && target.toLowerCase() !== record.copiedFromUsername.toLowerCase())
      throw new Error(`账号已 clone 到 @${record.copiedFromUsername}，不能直接更换目标；请使用新账号`);
    return record.copiedFromUsername;
  }
  if (!target) throw new Error('账号尚未 clone，请用 --target <博主用户名> 指定目标');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(target)) throw new Error('目标用户名无效');
  return target;
}
