import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitBrowserClient, localBitBrowserOrigin } from '../scripts/browser/bitbrowser-client.ts';

test('仅允许本地 API 和本地浏览器调试端点', async () => {
  assert.equal(localBitBrowserOrigin('http://127.0.0.1:54345'), 'http://127.0.0.1:54345');
  for (const input of ['https://127.0.0.1:54345', 'http://example.com:54345', 'http://127.0.0.1:54345/other', 'http://user:pass@localhost:54345']) assert.throws(() => localBitBrowserOrigin(input));
  let received: any;
  const client = new BitBrowserClient('http://localhost:54345', async (url, init) => {
    received = { url, method: init.method, body: JSON.parse(String(init.body)) };
    if (String(url).endsWith('/health')) return Response.json({});
    return Response.json({ success: true, data: { ws: 'ws://127.0.0.1:43210/devtools/browser/abc-def', coreVersion: '130' } });
  });
  await client.health();
  const result = await client.open('window_1', ['/tmp/a', '/tmp/b']);
  assert.equal(result.ws, 'ws://127.0.0.1:43210/devtools/browser/abc-def');
  assert.deepEqual(received.body, { id: 'window_1', args: ['--load-extension=/tmp/a,/tmp/b'] });
  await assert.rejects(client.open('window/1'), /窗口 ID/);
  await assert.rejects(client.open('window1', ['/tmp/a,b']), /扩展路径/);
  const malicious = new BitBrowserClient('http://localhost:54345', async () => Response.json({ success: true, data: { ws: 'ws://evil.example:1234/devtools/browser/abc' } }));
  await assert.rejects(malicious.open('window1'), /本机浏览器端点/);
});

test('不会把接口返回的敏感错误信息写入异常', async () => {
  const client = new BitBrowserClient('http://localhost:54345', async () => Response.json({ success: false, msg: 'cookie=secret' }));
  await assert.rejects(client.open('window1'), error => error instanceof Error && !error.message.includes('secret'));
});
