/** 验证测试浏览器调试端口校验的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyTestingListener } from '../scripts/browser/browser-connection.ts';

function runner(command, listeners = '123\n') {
  return async (file) => ({ stdout: file.endsWith('lsof') ? listeners : command });
}
const testing = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222';
test('accepts only a unique Google Chrome listener', async () => {
  assert.equal(await verifyTestingListener(9222, runner(testing), 'darwin'), 123);
  const bundled = chromium.executablePath().replace(join(homedir(), 'Library', 'Caches', 'ms-playwright'), resolve('.data/playwright-browsers'));
  assert.equal(await verifyTestingListener(9222, runner(`${bundled} --remote-debugging-port=9222`), 'darwin'), 123);
  await assert.rejects(verifyTestingListener(9222, runner('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), 'darwin'), /不是允许的/);
  await assert.rejects(verifyTestingListener(9222, runner(`${bundled}-imposter --remote-debugging-port=9222`), 'darwin'), /不是允许的/);
  await assert.rejects(verifyTestingListener(9222, runner(testing, '123\n456\n'), 'darwin'), /唯一/);
  await assert.rejects(verifyTestingListener(9222, runner(testing), 'linux'), /macOS/);
});

test('比特浏览器仅接受指定窗口对应的 PID、资料目录和端口监听者', async () => {
  const id = '3d29950121cb4755a97b8ee563031299';
  const command = `/Users/apple/Library/Application Support/BitBrowser/Chrome-bin/148/BitBrowser.app/Contents/MacOS/BitBrowser --user-data-dir=/Users/apple/Library/Application Support/BitBrowser/BrowserCache/${id} about:blank`;
  assert.equal(await verifyTestingListener(9222, runner(command), 'darwin', { pid: 123, windowId: id }), 123);
  await assert.rejects(verifyTestingListener(9222, runner(command), 'darwin', { pid: 124, windowId: id }), /不是允许的/);
  await assert.rejects(verifyTestingListener(9222, runner(command), 'darwin', { pid: 123, windowId: 'other' }), /不是允许的/);
  await assert.rejects(verifyTestingListener(9222, runner(testing), 'darwin', { pid: 123, windowId: id }), /不是允许的/);
});
