/** 验证自动执行只选择已授权且有 cookie 文件的账号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCookieAccounts } from '../scripts/loop/auto-select.ts';

test('selects only authenticated accounts with a cookie file', () => {
  const accounts = [
    { id: 1, uuid: '111', username: 'a', authenticated: true },
    { id: 2, uuid: '222', username: 'b', authenticated: true },
    { id: 3, uuid: '333', username: 'c', authenticated: false },
    { id: 4, uuid: null, username: 'd', authenticated: true },
  ] as any;
  assert.deepEqual(selectCookieAccounts(accounts, (id) => id === '111' || id === '333').map((a) => a.uuid), ['111']);
});
