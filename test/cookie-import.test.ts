/** 验证批量 cookie 导入的解析、规范化与落盘权限。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdFromCookie, parseCookieImportPayload, parseCookieValue, writeCookieFile } from '../scripts/browser/cookie-import.ts';

test('parses bulk cookie payloads by account id or username', () => {
  const entries = parseCookieImportPayload({ accounts: [
    { accountId: '123', cookie: { auth_token: 'a', ct0: 'b' } },
    { username: '@Alice', cookie: 'auth_token=c; ct0=d;' },
  ] });
  assert.deepEqual(entries.map((entry) => [entry.accountId, entry.username]), [['123', undefined], [undefined, 'Alice']]);
});

test('rejects incomplete or invalid payloads', () => {
  assert.throws(() => parseCookieImportPayload({}), /twid|数组/);
  assert.throws(() => parseCookieImportPayload([]), /没有可导入/);
  assert.throws(() => parseCookieImportPayload([{ cookie: {} }]), /accountId|twid/);
  assert.throws(() => parseCookieImportPayload([{ accountId: 'bad', cookie: {} }]), /accountId 无效/);
  assert.throws(() => parseCookieImportPayload([{ username: 'bad-name', cookie: {} }]), /username 无效/);
});

test('accepts cookie objects, JSON, Netscape and Cookie headers', () => {
  assert.deepEqual(parseCookieValue('auth_token=a; ct0=b;'), [{ name: 'auth_token', value: 'a', domain: '.x.com' }, { name: 'ct0', value: 'b', domain: '.x.com' }]);
  assert.equal((parseCookieValue('[{"name":"auth_token","value":"a"}]') as unknown[]).length, 1);
  assert.equal((parseCookieValue('.x.com\tTRUE\t/\tTRUE\t1800000000\tauth_token\ta\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1900000000\tct0\tb\n') as unknown[]).length, 2);
});

test('writes a 0600 cookie file with normalized cookies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xbot-cookie-import-'));
  try {
    const result = writeCookieFile(dir, '123', { auth_token: 'a', ct0: 'b' });
    assert.equal(result.count, 2);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.deepEqual(parsed.cookies.map((cookie: { name: string }) => cookie.name), ['auth_token', 'ct0']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects cookies without auth_token or ct0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xbot-cookie-import-'));
  try {
    assert.throws(() => writeCookieFile(dir, '123', { auth_token: 'a' }), /缺少 ct0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accepts a bare Chrome extension cookie array and derives the account from twid', () => {
  const cookies = [
    { domain: '.x.com', name: 'auth_token', value: 'a' },
    { domain: '.x.com', name: 'twid', value: 'u%3D1234567890' },
    { domain: '.x.com', name: 'ct0', value: 'b' },
  ];
  assert.equal(accountIdFromCookie(cookies), '1234567890');
  const entries = parseCookieImportPayload(cookies);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].accountId, '1234567890');
  assert.equal((entries[0].cookie as unknown[]).length, 3);
});

test('derives from wrapped cookie arrays and single storage-state objects', () => {
  const cookies = [
    { name: 'auth_token', value: 'a', domain: '.x.com' },
    { name: 'twid', value: 'u=42', domain: '.x.com' },
    { name: 'ct0', value: 'b', domain: '.x.com' },
  ];
  assert.equal(parseCookieImportPayload([{ cookie: cookies }])[0].accountId, '42');
  assert.equal(parseCookieImportPayload({ cookies })[0].accountId, '42');
  assert.throws(() => parseCookieImportPayload([{ name: 'auth_token', value: 'a' }]), /twid/);
});
