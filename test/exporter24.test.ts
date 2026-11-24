/** 验证 exporter24 扩展页读取计数、5 星门槛登录及未安装时的回退。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureExporter24Auth, exchangeExporter24Token, exporter24Gate, loginExporter24,
  openExporter24, readExporter24Counts, readExporter24User,
} from '../scripts/browser/exporter24.ts';

test('reads the two counts from the exporter24 result card', async () => {
  const page = {
    bringToFront: async () => {},
    locator: () => ({ first: () => ({ fill: async () => {}, press: async () => {} }) }),
    getByText: (pattern: RegExp) => ({ first: () => (
      pattern.source.includes('alice')
        ? { waitFor: async () => {} }
        : { innerText: async () => '' }
    ) }),
    getByRole: (_role: string, options: { name: RegExp }) => ({
      first: () => ({
        waitFor: async () => {},
        innerText: async () => options.name.source.includes('Followers') ? 'Followers: 80.5K' : 'Following: 90',
      }),
    }),
  };
  const oldToken = process.env.X_EXPORT_TOKEN;
  delete process.env.X_EXPORT_TOKEN;
  try { assert.deepEqual(await readExporter24Counts(page as any, 'alice'), { followers: 80500, following: 90 }); } finally { if (oldToken !== undefined) process.env.X_EXPORT_TOKEN = oldToken; }
});

test('returns null when the extension page cannot be opened', async () => {
  const context = {
    newPage: async () => ({
      goto: async () => { throw new Error('extension not installed'); },
      close: async () => {},
    }),
  };
  assert.equal(await openExporter24(context as any), null);
});

test('detects the 5-star review, sign-in and credits gates', () => {
  assert.equal(exporter24Gate('🎉 Special Offer! 🎉\nLeave us a 5-star review and get unlimited exports for free!'), 'review');
  assert.equal(exporter24Gate('Sign in / Sign up'), 'signin');
  assert.equal(exporter24Gate('Insufficient credits'), 'credits');
  assert.equal(exporter24Gate('Export Follower/Following Profiles\nHistory'), null);
});

test('logs in before use even when no gate is shown and reuses the verified session', async () => {
  let stored: any = null, exchanges = 0, reloads = 0;
  const page = {
    locator: () => ({ innerText: async () => 'Export Follower/Following Profiles' }),
    evaluate: async (_fn: any, arg: any) => typeof arg === 'string' ? stored : (stored = arg.value),
    reload: async () => { reloads++; },
  };
  const options = { token: 'login-code', exchange: async () => { exchanges++; return { name: 'Alice', email: 'a@example.com', avatar: '', token: 'session' }; } };
  assert.equal(await ensureExporter24Auth(page as any, undefined, options), 'logged-in');
  assert.equal(await ensureExporter24Auth(page as any, undefined, options), 'already');
  assert.equal(exchanges, 1);
  assert.equal(reloads, 1);
});

test('logs in with X_EXPORT_TOKEN when the 5-star gate is shown', async () => {
  let stored: any = { name: 'Old', email: 'old@example.com', avatar: '', token: 'old-token' };
  let reloads = 0;
  let exchanged = '';
  const page = {
    locator: () => ({ innerText: async () => '🎉 Special Offer! 🎉 Leave us a 5-star review and get unlimited exports for free!' }),
    evaluate: async (_fn: any, arg: any) => {
      if (typeof arg === 'string') return stored;
      stored = arg.value;
    },
    reload: async () => { reloads++; },
  };
  const account = { name: 'Alice', email: 'alice@example.com', avatar: '', token: 'session-token' };
  const result = await ensureExporter24Auth(page as any, undefined, {
    token: 'login-code',
    exchange: async code => { exchanged = code; return account; },
  });
  assert.equal(result, 'logged-in');
  assert.equal(exchanged, 'login-code');
  assert.equal(reloads, 1);
  assert.deepEqual(stored, account);
  assert.deepEqual(await readExporter24User(page as any), account);
});

test('reports the missing token instead of silently falling back', async () => {
  const page = { locator: () => ({ innerText: async () => 'Leave us a 5-star review' }) };
  await assert.rejects(
    ensureExporter24Auth(page as any, undefined, { token: '' }),
    /X_EXPORT_TOKEN/,
  );
});

test('writes the exchanged account into extension storage and reloads the page', async () => {
  let stored: any = null;
  let reloads = 0;
  const page = {
    evaluate: async (_fn: any, arg: any) => {
      if (typeof arg === 'string') return stored;
      stored = arg.value;
    },
    reload: async () => { reloads++; },
  };
  const account = { name: 'Alice', email: 'alice@example.com', avatar: 'https://avatar', token: 'session-token' };
  await loginExporter24(page as any, account);
  assert.equal(reloads, 1);
  assert.deepEqual(stored, account);
  assert.deepEqual(await readExporter24User(page as any), account);
});

test('exchanges the login code through the official endpoint', async () => {
  const original = globalThis.fetch;
  let request: { url: string; body: unknown } | null = null;
  globalThis.fetch = (async (url: string, init: any) => {
    request = { url: String(url), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ token: 'session', user: { email: 'alice@example.com', image: 'https://avatar' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
  try {
    assert.deepEqual(await exchangeExporter24Token(' login-code '), {
      name: 'alice', email: 'alice@example.com', avatar: 'https://avatar', token: 'session',
    });
    assert.equal(request!.url, 'https://www.exporter24.net/api/user');
    assert.deepEqual(request!.body, { token: 'login-code' });
  } finally {
    globalThis.fetch = original;
  }
});

test('rejects an expired login code', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  })) as any;
  try {
    await assert.rejects(exchangeExporter24Token('expired'), /登录失败/);
  } finally {
    globalThis.fetch = original;
  }
});

test('logs in and retries a blocked count read with the configured token', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.X_EXPORT_TOKEN;
  let body = '🎉 Special Offer! 🎉 Leave us a 5-star review and get unlimited exports for free!';
  let loggedIn = false;
  let reloads = 0;
  const page = {
    bringToFront: async () => {},
    locator: (selector: string) => selector === 'body'
      ? { innerText: async () => body }
      : { first: () => ({ fill: async () => {}, press: async () => {} }) },
    getByText: () => ({ first: () => ({ waitFor: async () => {}, innerText: async () => '' }) }),
    getByRole: (_role: string, options: { name: RegExp }) => ({
      first: () => ({
        waitFor: async () => {},
        innerText: async () => options.name.source.includes('Followers') ? 'Followers: 1.5K' : '',
      }),
    }),
    evaluate: async (_fn: any, arg: any) => {
      if (typeof arg === 'string') return loggedIn ? { name: 'Alice', email: 'alice@example.com', avatar: '', token: 'session' } : null;
      loggedIn = true;
    },
    reload: async () => { reloads++; body = 'Export Follower/Following Profiles'; },
  };
  process.env.X_EXPORT_TOKEN = 'login-code';
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'session', user: { email: 'alice@example.com' } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as any;
  try {
    const counts = await readExporter24Counts(page as any, 'alice');
    assert.equal(reloads, 1);
    assert.deepEqual(counts, { followers: 1500, following: undefined });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.X_EXPORT_TOKEN;
    else process.env.X_EXPORT_TOKEN = originalToken;
  }
});
