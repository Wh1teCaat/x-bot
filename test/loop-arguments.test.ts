/** 验证账号、浏览器及恢复参数不会串用到其他任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoopArguments } from '../scripts/loop/loop-arguments.ts';

test('accepts account-bound browser arguments without environment variables', () => {
  assert.deepEqual(parseLoopArguments(['--account-id', '123', '--username', 'Alice', '--cdp-port', '9334']), {
    followProbe: false, accountId: '123', username: 'Alice', cdpPort: 9334,
  });
});

test('rejects malformed, repeated, unbound and internal-only arguments', () => {
  for (const args of [
    ['--username', 'Alice'], ['--account-id', '../1'], ['--cdp-port', '70000'],
    ['--account-id', '1', '--account-id', '2'], ['--follow-probe'], ['--run-id', 'x'],
  ]) assert.throws(() => parseLoopArguments(args));
});

test('allows probe only when resuming a validated run', () => {
  const id = 'caa8770d-5484-4f96-9631-99904db39e74';
  assert.equal(parseLoopArguments(['--resume', id, '--follow-probe'], true).followProbe, true);
  assert.throws(() => parseLoopArguments(['--follow-probe'], true));
});
