/** 验证原帖菜单关注和回复身份匹配的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectArabicReplyCandidates, partitionReplyCandidates } from '../scripts/reply-candidates.ts';
import { followFromThread, matchThreadReply } from '../scripts/thread-follow.ts';

test('filters CSV reply language, validates post ID and deduplicates authors', () => {
  const csv = 'id,text,profileUrl,postUrl\n11,مرحبا,https://x.com/User,https://x.com/root/status/10\n12,hello,https://x.com/User,https://x.com/root/status/10\n13,السعودية,https://x.com/user,https://x.com/root/status/10\n14,مرحبا,https://x.com/Other,https://x.com/root/status/99\n';
  const c = collectArabicReplyCandidates(csv, '10');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].replyIds, ['11', '13']);
  assert.equal(matchThreadReply('/User/status/11', c[0]), true);
  assert.equal(matchThreadReply('/Other/status/11', c[0]), false);
  assert.equal(matchThreadReply('/User/status/12', c[0]), false);
});

test('puts Arabic authors directly in the set and sends only remaining authors for evaluation', () => {
  const csv = 'id,text,profileUrl,postUrl\n11,hello,https://x.com/A,https://x.com/root/status/10\n12,مرحبا,https://x.com/a,https://x.com/root/status/10\n13,hello,https://x.com/B,https://x.com/root/status/10\n14,world,https://x.com/b,https://x.com/root/status/10\n';
  const { direct, remaining } = partitionReplyCandidates(csv, '10');
  assert.deepEqual(direct.map(c => c.username), ['A']);
  assert.deepEqual(direct[0].replyIds, ['11', '12']);
  assert.deepEqual(remaining.map(c => c.username), ['B']);
  assert.deepEqual(remaining[0].replyIds, ['13', '14']);
});

test('matches exact reply and follows via its menu without opening a profile', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage();
  const calls = [];
  const statuses = new Map();
  const store = {
    status: (a, n) => statuses.get(`${a}:${n}`),
    reserve: (a, n) => { statuses.set(`${a}:${n}`, 'uncertain'); return true; },
    record: (a, n, s) => statuses.set(`${a}:${n}`, s),
  };
  await page.route('https://x.com/**', async route => {
    calls.push(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><a data-testid="AppTabBar_Profile_Link" href="/me">Profile</a>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/root">root</a></div><a href="/root/status/10"><time>time</time></a></article>
      <article id="target" data-testid="tweet"><div data-testid="User-Name"><a href="/Target">target</a></div><a href="/Target/status/11"><time>time</time></a><button data-testid="caret" onclick="document.querySelector('#menu').hidden=false">More</button></article>
      <article data-testid="tweet"><div data-testid="User-Name"><a href="/Other">other</a></div><a href="/Other/status/12"><time>time</time></a><button data-testid="caret" onclick="document.querySelector('#other-menu').hidden=false">More</button></article>
      <div id="menu" role="menu" hidden><button role="menuitem" id="follow" onclick="this.textContent='Unfollow @Target';document.querySelector('#menu').hidden=true;document.body.append(document.querySelector('#target'))">Follow @Target</button></div>
      <div id="other-menu" role="menu" hidden><button role="menuitem">Follow @Other</button></div>` });
  });
  page.waitForTimeout = async () => {};
  try {
    const result = await followFromThread(page, { url: 'https://x.com/root/status/10' }, [{ username: 'Target', replyIds: ['11'] }, { username: 'Other', replyIds: ['12'] }], store, async () => {}, () => {}, { maxNewFollows: 1 });
    assert.deepEqual(result.matched, [{ username: 'Target', status: 'following' }]);
    assert.deepEqual(result.unresolved, ['other']);
    assert.equal(result.probeSucceeded, true);
    assert.equal(statuses.get('me:target'), 'following');
    assert.equal(statuses.has('me:other'), false);
    assert.deepEqual(calls, ['https://x.com/root/status/10']);
  } finally { await browser.close(); }
});

test('does not follow a user from a reply ID absent from the selected set', () => {
  const candidate = { username: 'author', replyIds: ['123'] };
  assert.equal(matchThreadReply('/author/status/456', candidate), false);
  assert.equal(matchThreadReply('/other/status/123', candidate), false);
});

test('excludes very short Arabic symbols and preserves the correct post association', () => {
  const csv = 'id,text,profileUrl,postUrl\n21,١٢٣,https://x.com/a,https://x.com/root/status/10\n22,في,https://x.com/b,https://x.com/root/status/10\n23,مرحبا,https://x.com/c,https://x.com/root/status/11\n';
  assert.deepEqual(collectArabicReplyCandidates(csv, '10').map(c => c.username), ['b']);
});
