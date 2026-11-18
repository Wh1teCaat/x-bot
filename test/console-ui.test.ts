import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { configSchema } from '../src/runtime-config.ts';
import { chromium } from 'playwright';

test('console expands account logs, preserves expansion on refresh, filters and escapes external text', { skip: process.env.XBOT_BROWSER_TEST !== '1' }, async () => {
  const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const now = Date.now();
  const alice = { id: '1', username: 'alice', name: 'Alice Studio', status: 'running', stats: { following: 128, mutual: 36, queued: 72, pending: 3, uncertain: 0, manual: 0, inbound: 41 }, sessions: [
    { worker: 'loop', stage: '抓取粉丝（200 人）', status: 'running', stageStatus: 'running' },
    { worker: 'outbox', stage: '等待下一批关注', status: 'running', stageStatus: 'waiting' },
  ], checkpoints: [{ blogger: 'fashion', offset: 400, due: now + 1800000, done: false }], nextFollowAt: now + 300000 };
  const bob = { ...alice, id: '2', username: 'bob', name: '<img src=x onerror="window.injected=true">', status: 'interrupted', sessions: [], stats: { ...alice.stats, following: 52, mutual: 12, queued: 0 }, checkpoints: [], nextFollowAt: null };
  const fixture = { generatedAt: now, accounts: [alice, bob], logs: [], steps: [], nextBefore: null };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let fail = false, starts = 0, batchStarts = 0;
  await page.route('http://console.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/console') return route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('../src/console.html', import.meta.url), 'utf8') });
    if (url.pathname === '/api/settings') {
      if (route.request().method() === 'PUT') {
        assert.equal(route.request().postDataJSON().values.MIRROR_INTERVAL_MS, 90000);
        return route.fulfill({ json: { revision: 'saved' } });
      }
      return route.fulfill({ json: { revision: 'initial', schema: configSchema, values: Object.fromEntries(Object.entries(configSchema).map(([key, rule]) => [key, rule.default])) } });
    }
    if (url.pathname === '/api/console/start-all') {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), { confirm: true });
      batchStarts++;
      return route.fulfill({ status: 202, json: { message: '已启动 1 个，跳过 1 个，失败 0 个', results: [
        { username: 'alice', message: '正在运行' }, { username: 'bob', message: '长 loop 已启动' },
      ] } });
    }
    if (url.pathname === '/api/console/2/start') {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), { target: '@fashion', confirm: true });
      starts++;
      return route.fulfill({ status: 202, json: { message: '长 loop 已启动' } });
    }
    if (fail) return route.fulfill({ status: 503, body: '{}' });
    assert.equal(route.request().headers()['x-local-request'], '1');
    const detail = /^\/api\/console\/[12]$/.test(url.pathname);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(detail ? { ...fixture, accounts: [url.pathname === '/api/console/2' ? bob : alice],
      steps: [{ id: 1, name: '筛选关注/粉丝比例', worker: 'loop', status: 'completed', startedAt: now - 90000, endedAt: now - 30000, durationMs: 60000 }],
      logs: [{ id: url.search ? 1 : 101, level: 'info', message: url.search ? '更早的日志' : '<script>window.injected=true</script> 粉丝本批 200 人', createdAt: now, elapsedMs: 1500, stage: '抓取粉丝', worker: 'loop' }], nextBefore: url.search ? null : 101 } : fixture) });
  });
  try {
    await page.goto('http://console.test/console');
    await page.waitForFunction(() => document.querySelectorAll('details').length === 2);
    assert.equal(await page.locator('#following').innerText(), '180');
    assert.equal(await page.locator('#updated').count(), 0);
    assert.equal(await page.locator('.account-light.running').count(), 1);
    assert.equal(await page.locator('.account-light.error').count(), 1);
    await page.locator('#settings-open').click();
    await page.locator('input[name="MIRROR_INTERVAL_MS"]').fill('90000');
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent?.includes('已保存'));
    await page.locator('#settings-close').click();
    await page.locator('details[data-id="1"] summary').click();
    await page.waitForSelector('.logs .log');
    assert.match(await page.locator('.table-wrap').innerText(), /1 分 0 秒/);
    assert.equal(await page.locator('img,script[src]').count(), 0);
    assert.equal(await page.evaluate(() => (window as any).injected), undefined);
    await page.locator('#refresh').click();
    await page.waitForFunction(() => !(document.querySelector('#refresh') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('details[data-id="1"]').getAttribute('open'), '');
    if (process.env.XBOT_CONSOLE_SCREENSHOT) await page.screenshot({ path: process.env.XBOT_CONSOLE_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: '更早日志' }).click();
    await page.waitForFunction(() => document.querySelector('.logs')?.textContent?.includes('更早的日志'));
    await page.getByRole('button', { name: '返回最新' }).click();
    await page.waitForFunction(() => document.querySelector('.logs')?.textContent?.includes('粉丝本批'));
    await page.locator('details[data-id="2"] summary').click();
    await page.locator('details[data-id="2"] button[data-action="start"]').click();
    await page.locator('#start-target').fill('@fashion');
    await page.locator('#start-submit').click();
    await page.waitForFunction(() => document.querySelector('#start-status')?.textContent?.includes('已启动'));
    assert.equal(starts, 1);
    await page.locator('#start-cancel').click();
    assert.equal(await page.locator('details[data-id="1"] button[data-action="start"]').isDisabled(), true);
    await page.locator('#filter').selectOption('running');
    assert.equal(await page.locator('details:visible').count(), 1);
    await page.locator('#search').fill('no-match');
    assert.equal(await page.locator('#no-results').isVisible(), true);
    await page.locator('#start-all').click();
    assert.equal(await page.locator('#start-target').isVisible(), false);
    await page.locator('#start-submit').click();
    await page.waitForFunction(() => document.querySelector('#start-status')?.textContent?.includes('跳过 1 个'));
    assert.match(await page.locator('#start-status').innerText(), /@bob：长 loop 已启动/);
    assert.equal(batchStarts, 1);
    await page.locator('#start-cancel').click();
    await page.locator('#search').fill('');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    fail = true; await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('503'));
    assert.equal(await page.locator('details:visible').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
