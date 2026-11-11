/** 验证授权账号与浏览器登录和插件状态的绑定规则。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountReadiness, waitForAccountReady } from '../scripts/account-readiness.ts';

test('starts only after the matching browser account and plugin are ready', () => {
  assert.equal(accountReadiness(null, 'Alice', true), 'login');
  assert.equal(accountReadiness('/Bob', 'Alice', true), 'wrong_account');
  assert.equal(accountReadiness('/alice', 'Alice', false), 'plugin');
  assert.equal(accountReadiness('/alice', 'Alice', true), 'ready');
});

test('waits through login, account mismatch and plugin authorization before continuing', async () => {
  const hrefs = [null, '/Bob', '/Alice', '/Alice'];
  const statuses = []; let i = 0, pluginChecks = 0;
  await waitForAccountReady({ username: 'Alice', profileHref: async () => hrefs[i],
    pluginReady: async () => ++pluginChecks > 1, wait: async () => { i++; },
    closed: () => false, onStatus: status => statuses.push(status) });
  assert.deepEqual(statuses, ['login', 'wrong_account', 'plugin']);
  assert.equal(pluginChecks, 2);
});
