/** 验证 cookie 文件解析、规范化与安全提示。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieFileCandidates, cookieFileFor, defaultCookiePath, loadCookieJar, normalizeCookieJar, parseCookieHeader, parseNetscapeCookies } from '../scripts/browser/cookies.ts';

const now = 1_700_000_000_000;

test('normalizes a plain { auth_token, ct0 } object', () => {
  const cookies = normalizeCookieJar({ auth_token: 'a'.repeat(40), ct0: 'b'.repeat(160) }, now);
  assert.deepEqual(cookies.map(cookie => cookie.name), ['auth_token', 'ct0']);
  for (const cookie of cookies) {
    assert.equal(cookie.domain, '.x.com');
    assert.equal(cookie.path, '/');
    assert.equal(cookie.secure, true);
    assert.equal(cookie.expires, Math.floor(now / 1000) + 365 * 24 * 60 * 60);
  }
  assert.equal(cookies.find(cookie => cookie.name === 'auth_token')?.httpOnly, true);
  assert.equal(cookies.find(cookie => cookie.name === 'ct0')?.httpOnly, false);
});

test('accepts Playwright storage state and Chrome extension exports', () => {
  const cookies = normalizeCookieJar({
    cookies: [
      { name: 'auth_token', value: 'a', domain: '.x.com', path: '/', expires: 1_800_000_000, sameSite: 'no_restriction' },
      { name: 'ct0', value: 'b', domain: 'x.com', expirationDate: 1_900_000_000, sameSite: 'lax', httpOnly: false },
      { name: 'guest_id', value: 'c', domain: 'twitter.com', secure: false },
    ],
  }, now);
  assert.equal(cookies.length, 3);
  const auth = cookies.find(cookie => cookie.name === 'auth_token')!;
  assert.equal(auth.expires, 1_800_000_000);
  assert.equal(auth.sameSite, 'None');
  const ct0 = cookies.find(cookie => cookie.name === 'ct0')!;
  assert.equal(ct0.expires, 1_900_000_000);
  assert.equal(ct0.sameSite, 'Lax');
  assert.equal(ct0.secure, true);
  const guest = cookies.find(cookie => cookie.name === 'guest_id')!;
  assert.equal(guest.domain, 'twitter.com');
  assert.equal(guest.secure, false);
});

test('ignores cookies for other sites but still requires auth_token and ct0', () => {
  assert.throws(() => normalizeCookieJar([
    { name: 'auth_token', value: 'a', domain: '.x.com' },
    { name: 'session', value: 's', domain: '.example.com' },
  ]), /缺少 ct0/);
});

test('rejects malformed values and unsupported shapes', () => {
  assert.throws(() => normalizeCookieJar({ auth_token: 'a b', ct0: 'c' }), /含空白或分号/);
  assert.throws(() => normalizeCookieJar({ foo: 'bar' }), /格式无效/);
});

test('loads a file and warns when permissions are too broad', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-cookies-'));
  const path = join(dir, 'cookies.json');
  try {
    await writeFile(path, JSON.stringify({ auth_token: 'a', ct0: 'b' }), { mode: 0o644 });
    await chmod(path, 0o644);
    const jar = await loadCookieJar(path);
    assert.equal(jar.cookies.length, 2);
    assert.equal(jar.warnings.length, 1);
    assert.match(jar.warnings[0], /chmod 600/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parses Netscape cookies.txt exports including HttpOnly lines', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '.x.com\tTRUE\t/\tTRUE\t1800000000\tauth_token\ta',
    '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1900000000\tct0\tb',
  ].join('\n');
  const cookies = normalizeCookieJar(parseNetscapeCookies(text));
  assert.equal(cookies.length, 2);
  const auth = cookies.find(cookie => cookie.name === 'auth_token')!;
  assert.equal(auth.expires, 1_800_000_000);
  assert.equal(auth.secure, true);
  const ct0 = cookies.find(cookie => cookie.name === 'ct0')!;
  assert.equal(ct0.httpOnly, true);
});

test('parses a raw Cookie request header', () => {
  const cookies = normalizeCookieJar(parseCookieHeader('auth_token=abc; ct0=def; guest_id=v1%3A123; twid=u%3D42'));
  assert.deepEqual(cookies.map(cookie => cookie.name).sort(), ['auth_token', 'ct0', 'guest_id', 'twid']);
  assert.equal(cookies.find(cookie => cookie.name === 'guest_id')?.value, 'v1%3A123');
});

test('loads a raw Cookie header file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-cookies-'));
  const path = join(dir, 'cookies.txt');
  try {
    await writeFile(path, 'auth_token=abc; ct0=def\n', { mode: 0o600 });
    const jar = await loadCookieJar(path);
    assert.equal(jar.cookies.length, 2);
    assert.deepEqual(jar.warnings, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loads a Netscape file and rejects unusable content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xbot-cookies-'));
  const path = join(dir, 'cookies.txt');
  try {
    await writeFile(path, '.x.com\tTRUE\t/\tTRUE\t1800000000\tauth_token\ta\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1900000000\tct0\tb\n', { mode: 0o600 });
    const jar = await loadCookieJar(path);
    assert.equal(jar.cookies.length, 2);
    assert.deepEqual(jar.warnings, []);
    await writeFile(path, 'not a cookie file');
    await assert.rejects(loadCookieJar(path), /没有可用|7 个制表符/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('resolves the default and overridden cookie paths', () => {
  assert.equal(defaultCookiePath('123'), join(process.cwd(), '.data', 'cookies', '123.json'));
  assert.equal(cookieFileFor('123', {}), defaultCookiePath('123'));
  assert.equal(cookieFileFor('123', { X_COOKIE_FILE: 'tmp/custom.json' }), join(process.cwd(), 'tmp', 'custom.json'));
  assert.deepEqual(cookieFileCandidates('123', {}), [
    defaultCookiePath('123'),
    join(process.cwd(), '.data', 'cookies', '123.txt'),
  ]);
  assert.deepEqual(cookieFileCandidates('123', { X_COOKIE_FILE: 'tmp/custom.txt' }), [join(process.cwd(), 'tmp', 'custom.txt')]);
});
