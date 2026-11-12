/** 验证只有真实环境中具备必要权限的授权才会启动浏览器任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSessionArguments, shouldAutoStartAccountSession } from '../src/account-session-manager.ts';

test('requires both scopes and respects the auto-start setting', () => {
  assert.equal(shouldAutoStartAccountSession('users.read follows.write', {}), false);
  assert.equal(shouldAutoStartAccountSession('users.read follows.write', { setting: 'true' }), true);
  assert.equal(shouldAutoStartAccountSession('users.read follows.read', {}), false);
  assert.equal(shouldAutoStartAccountSession('users.read follows.write', { setting: 'false' }), false);
  assert.equal(shouldAutoStartAccountSession('users.read follows.write', { nodeEnv: 'test' }), false);
});

test('passes only a validated account identity to the isolated session', () => {
  assert.deepEqual(accountSessionArguments({ id: '123', username: 'Alice' }), ['scripts/account/account-session.ts', '123', 'Alice']);
  assert.throws(() => accountSessionArguments({ id: '../123', username: 'Alice' }));
  assert.throws(() => accountSessionArguments({ id: '123', username: '../Alice' }));
});
