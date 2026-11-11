/** 验证帖子回复数解析与页面选择的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyCount, bestPost, panelAction } from '../scripts/reply-export.ts';
import { chromium } from 'playwright';

test('parses visible reply counts and rejects unrecognized text', () => {
  for (const [input, expected] of [['', 0], ['1,234', 1234], ['1.9K', 1900], ['2M', 2000000], ['3万', 30000], ['45 replies', 45], ['unavailable', null]]) {
    assert.equal(parseReplyCount(input), expected);
  }
});

test('chooses the first highest count and ignores unreadable counts', () => {
  assert.deepEqual(bestPost([{ replies: null }, { replies: 12, url: 'a' }, { replies: 12, url: 'b' }, { replies: 4 }]), { replies: 12, url: 'a' });
  assert.equal(bestPost([{ replies: null }]), null);
});

test('reuses a marked X tab, then an existing X tab, before opening a new tab', async () => {
  const { getCollectorPage } = await import('../scripts/reply-export.ts');
  const tab = (url, marked = false) => ({ url: () => url, evaluate: async () => marked });
  const marked = tab('https://x.com/search?q=first', true);
  const other = tab('https://x.com/home');
  let opened = 0;
  const context = pages => ({ pages: () => pages, newPage: async () => { opened++; return 'new'; } });
  assert.equal(await getCollectorPage(context([marked, other])), marked);
  assert.equal(await getCollectorPage(context([other])), other);
  assert.equal(await getCollectorPage(context([tab('https://example.com/')])), 'new');
  assert.equal(opened, 1);
});

test('handles CommentCrate onboarding and an already open panel', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="commentcrate-panel-host"></div>');
    await page.evaluate(() => {
      const root = document.querySelector('#commentcrate-panel-host')!.attachShadow({ mode: 'closed' });
      root.innerHTML = '<div class="intro"><button class="go">Scan</button></div><button aria-label="Scan comments" style="display:none">Scan</button>';
      root.querySelector('.go')!.addEventListener('click', () => { document.body.dataset.scanned = 'intro'; });
    });
    const session = await page.context().newCDPSession(page);
    await panelAction(session, 'open');
    await panelAction(session, 'scan');
    assert.equal(await page.locator('body').getAttribute('data-scanned'), 'intro');
    await session.detach();
  } finally { await browser.close(); }
});
