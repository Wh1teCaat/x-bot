/** 批量启动使用同一账号启动入口；单个失败不阻断其他账号。 */
export async function startAllConsoleLoops(
  accounts: { uuid?: string | null; username?: string; authenticated?: boolean }[],
  start: (id: string) => Promise<{ pid?: number }>,
) {
  const results: { id: string; username: string; status: 'started' | 'skipped' | 'failed'; message: string }[] = [];
  for (const account of accounts) {
    if (!account.uuid) continue;
    const identity = { id: account.uuid, username: account.username || account.uuid };
    if (!account.authenticated) {
      results.push({ ...identity, status: 'skipped', message: '账号未授权' });
      continue;
    }
    try {
      await start(account.uuid);
      results.push({ ...identity, status: 'started', message: '长 loop 已启动' });
    } catch (error) {
      results.push({ ...identity, status: error.status === 409 ? 'skipped' : 'failed',
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
