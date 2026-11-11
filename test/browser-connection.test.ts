/** 验证测试浏览器调试端口校验的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTestingListener } from '../scripts/browser-connection.ts';

function runner(command, listeners = '123\n') {
  return async (file) => ({ stdout: file.endsWith('lsof') ? listeners : command });
}
const testing = '/Users/test/Library/Caches/ms-playwright/chromium-1/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=9222';
test('accepts only a unique Chrome for Testing listener', async () => {
  assert.equal(await verifyTestingListener(9222, runner(testing), 'darwin'), 123);
  await assert.rejects(verifyTestingListener(9222, runner('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'darwin'), /不是 Chrome for Testing/);
  await assert.rejects(verifyTestingListener(9222, runner(testing, '123\n456\n'), 'darwin'), /唯一/);
  await assert.rejects(verifyTestingListener(9222, runner(testing), 'linux'), /macOS/);
});
