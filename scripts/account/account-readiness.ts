/** 判断独立浏览器能否安全开始已授权账号的单轮任务。 */
export type AccountReadiness = 'login' | 'wrong_account' | 'plugin' | 'ready';

/** 登录账号、授权账号和插件权限都匹配后才允许执行任务。 */
export function accountReadiness(profileHref: string | null, username: string, pluginReady: boolean): AccountReadiness {
  if (!profileHref) return 'login';
  if (profileHref.toLowerCase() !== `/${username.toLowerCase()}`) return 'wrong_account';
  return pluginReady ? 'ready' : 'plugin';
}

/** 等待用户完成登录与插件授权；账号不匹配时不检查插件或执行任务。 */
export async function waitForAccountReady({ username, profileHref, pluginReady, wait, closed, onStatus }: {
  username: string; profileHref: () => Promise<string | null>; pluginReady: () => Promise<boolean>;
  wait: () => Promise<void>; closed: () => boolean; onStatus: (status: AccountReadiness) => void;
}): Promise<void> {
  let last: AccountReadiness | null = null;
  while (!closed()) {
    const href = await profileHref();
    const matching = !!href && href.toLowerCase() === `/${username.toLowerCase()}`;
    const status = accountReadiness(href, username, matching && await pluginReady());
    if (status === 'ready') return;
    if (status !== last) { onStatus(status); last = status; }
    await wait();
  }
  throw new Error('浏览器已关闭');
}
