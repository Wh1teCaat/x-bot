import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitBrowserClient, BitBrowserOpenError, BitBrowserUnavailableError } from '../scripts/browser/bitbrowser-client.ts';
import { browserFailureExitCode, followerBatchFailure, nextFollowerBrowserRetry } from '../scripts/loop/follower-schedule-retry.ts';

test('仅采集前的比特 API 连接失败自动重试，采集中断及其他异常必须暂停', async () => {
  const client = new BitBrowserClient('http://127.0.0.1:54345', async () => { throw new Error('ECONNREFUSED'); });
  let unavailable: unknown;
  try { await client.health(); } catch (error) { unavailable = error; }
  assert.ok(unavailable instanceof BitBrowserUnavailableError);
  assert.equal(followerBatchFailure(browserFailureExitCode(unavailable, false)), 'retry-browser');
  assert.equal(followerBatchFailure(browserFailureExitCode(unavailable, true)), 'blocked');
  assert.equal(followerBatchFailure(browserFailureExitCode(new Error('浏览器配置错误'), false)), 'blocked');
  assert.equal(followerBatchFailure(0), 'none');
});

test('窗口启动失败最多重试三次，间隔五分钟', () => {
  for (let previous = 0; previous < 3; previous++) assert.deepEqual(nextFollowerBrowserRetry(previous, 1000), { failures: previous + 1, blocked: false, retryAt: 301000 });
  assert.equal(nextFollowerBrowserRetry(3, 1000).blocked, true);
});

test('比特云端超时由 open 返回失败时安全有限重试，且不输出服务端内容', async () => {
  const client = new BitBrowserClient('http://127.0.0.1:54345', async () => Response.json({ success: false, msg: 'timeout cookie=secret' }));
  let failure: unknown;
  try { await client.open('slot'); } catch (error) { failure = error; }
  assert.ok(failure instanceof BitBrowserOpenError);
  assert.doesNotMatch(failure.message, /secret/);
  assert.equal(followerBatchFailure(browserFailureExitCode(failure, false)), 'retry-browser');
  assert.equal(followerBatchFailure(browserFailureExitCode(failure, true)), 'blocked');
  const denied = new BitBrowserClient('http://127.0.0.1:54345', async () => new Response('', { status: 403 }));
  await assert.rejects(denied.open('slot'), error => followerBatchFailure(browserFailureExitCode(error, false)) === 'blocked');
});
