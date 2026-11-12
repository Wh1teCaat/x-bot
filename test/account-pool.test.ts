/** 验证账号池位在人工登录确认前不连接浏览器，并在空闲时复用。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountPoolSlot } from '../scripts/account/account-pool.ts';
import { accountSocketPath } from '../scripts/account/account-socket.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('waits for manual ready, then reuses an idle account slot', async () => {
  let checks = 0, runs = 0;
  const slot = new AccountPoolSlot({ check: async () => { checks++; }, run: async () => { runs++; }, report: () => {} });
  assert.equal(slot.state, 'awaiting_login');
  assert.match(slot.run(), /先登录/); await tick(); assert.equal(checks, 0);
  slot.ready(); await tick(); assert.equal(checks, 1); assert.equal(runs, 1); assert.equal(slot.state, 'idle');
  slot.run(); await tick(); assert.equal(checks, 2); assert.equal(runs, 2); assert.equal(slot.state, 'idle');
});

test('does not run when account or extension validation fails', async () => {
  let runs = 0; const messages = [];
  const slot = new AccountPoolSlot({ check: async () => { throw new Error('缺少插件权限'); }, run: async () => { runs++; }, report: message => messages.push(message) });
  slot.ready(); await tick(); assert.equal(runs, 0); assert.equal(slot.state, 'awaiting_login'); assert.deepEqual(messages, ['缺少插件权限']);
});

test('uses account-specific socket paths and rejects invalid identifiers', () => {
  assert.notEqual(accountSocketPath('123'), accountSocketPath('456'));
  assert.throws(() => accountSocketPath('../123'));
});
