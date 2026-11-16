/** 从已授权账号中选出有 cookie 文件、可尝试自动登录的候选。 */
import type { AccountRecord } from '../../src/account-store.ts';

export function selectCookieAccounts(
  accounts: AccountRecord[],
  hasCookie: (accountId: string) => boolean,
): AccountRecord[] {
  return accounts.filter((account) =>
    Boolean(account.uuid) && account.authenticated && hasCookie(account.uuid!),
  );
}
