/** 读取博主帖子并控制 CommentCrate 扫描和导出回复。 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { actionDelay } from '../browser/action-delay.ts';

// 此对象只在浏览器扩展的页面执行上下文中存在，不在 Node 进程中使用。
declare const chrome: any;

const TAB_MARKER = 'x-bot-reply-collector';

/** 优先复用带采集标记或已有的 X 标签页。 */
export async function getCollectorPage(context) {
  const pages = context.pages();
  const xPages = pages.filter(page => /^https:\/\/x\.com(?:\/|$)/.test(page.url()));
  for (const page of xPages) {
    if (await page.evaluate(key => sessionStorage.getItem(key) === '1', TAB_MARKER).catch(() => false)) return page;
  }
  // The user asked to reuse an existing X tab. Never close unrelated tabs.
  return xPages.at(-1) || await context.newPage();
}

/** 解析页面显示的回复数量及常见单位。 */
export function parseReplyCount(text) {
  if (!text || !text.trim()) return 0;
  const normalized = text.trim().replace(/,/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([KMB万千]?)\s*(?:repl(?:y|ies)|回复|則回覆|回覆)?$/i);
  if (!match) return null;
  const factor = { k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '千': 1e3 }[match[2].toLowerCase()] || 1;
  return Math.round(Number(match[1]) * factor);
}

/** 从可识别回复数的帖子中选出回复最多的一条。 */
export function bestPost(posts) {
  return posts.filter(p => Number.isFinite(p.replies)).reduce((best, post) => !best || post.replies > best.replies ? post : best, null);
}

/** 滚动收集当前时间线中最多十条可识别帖子；给定作者时只保留该作者的帖子。 */
async function collectPosts(page, guard, limit = 10, author?: string) {
  const posts = new Map();
  let unchanged = 0;
  for (let i = 0; i < 20 && posts.size < limit && unchanged < 4; i++) {
    await guard();
    const articles = page.getByTestId('tweet');
    const n = await articles.count();
    const before = posts.size;
    for (let j = 0; j < n && posts.size < limit; j++) {
      const article = articles.nth(j);
      // The timestamp link identifies the outer post, unlike embedded quoted posts.
      const link = article.locator('a:has(time)').first();
      const href = await link.getAttribute('href').catch(() => null);
      if (!href || !/^\/[^/]+\/status\/\d+$/.test(href) || posts.has(href)) continue;
      if (author && !href.toLowerCase().startsWith(`/${author.toLowerCase()}/status/`)) continue;
      const reply = article.getByTestId('reply').first();
      if (!await reply.count()) continue;
      const visible = (await reply.innerText()).trim();
      const label = await reply.getAttribute('aria-label');
      const count = parseReplyCount(visible) ?? parseReplyCount(label);
      posts.set(href, { url: `https://x.com${href}`, replies: count });
    }
    unchanged = posts.size === before ? unchanged + 1 : 0;
    if (posts.size < limit) {
      await actionDelay(page);
      await page.mouse.wheel(0, 1300);
      await page.waitForTimeout(1800);
    }
  }
  return [...posts.values()];
}

/** 打开指定博主的公开主页，收集其本人帖子和回复数。 */
export async function findBloggerPosts(page, blogger, guard = () => {}) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(blogger)) throw new Error('博主用户名无效');
  await guard();
  await actionDelay(page);
  await page.goto(`https://x.com/${blogger}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(key => sessionStorage.setItem(key, '1'), TAB_MARKER);
  await page.getByTestId('tweet').first().waitFor({ timeout: 30000 });
  return collectPosts(page, guard, 10, blogger);
}

const EXTENSION_ID = 'haaahmifcccbgagmopbhbkgabgblmcbl';

// CommentCrate's panel is a closed shadow root. CDP resolves it without changing
// the extension or injecting code into the X page.
/** 通过 CDP 穿透扩展面板并执行指定控件操作。 */
export async function panelAction(session, action) {
  const doc = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#commentcrate-panel-host' });
  if (!nodeId) throw new Error('CommentCrate 面板尚未加载。');
  const { node } = await session.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
  const shadow = node.shadowRoots?.[0];
  if (!shadow) throw new Error('无法读取 CommentCrate 面板。');
  const { object } = await session.send('DOM.resolveNode', { nodeId: shadow.nodeId });
  try {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function(action) {
        const selectors = { open: '.pillopen', scan: 'button[aria-label="Scan comments"]', download: '.dlbtn', csv: '[data-format="csv"]' };
        const visible = e => !!e && !e.hidden && !e.disabled && !!e.getClientRects().length;
        const scan = this.querySelector(selectors.scan);
        const intro = this.querySelector('.intro button.go');
        // 首次安装的引导页面会遮住普通按钮，其 Scan 按钮执行同一个扫描动作。
        if (action === 'open' && (visible(scan) || visible(intro))) return true;
        const element = action === 'scan' && !visible(scan) && visible(intro) ? intro : this.querySelector(selectors[action]);
        if (!element || element.hidden || element.disabled || !element.getClientRects().length) return false;
        element.click(); return true;
      }`, arguments: [{ value: action }],
    });
    if (exceptionDetails || !result.value) throw new Error(`CommentCrate ${action} 控件不可用。`);
  } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
}

/** 启动 CommentCrate 扫描并将结果下载到本地 CSV。 */
export async function scanAndExport(page, post, outputDir = '.data/reply-exports', guard = () => {}) {
  const context = page.context();
  let helper;
  await guard();
  await actionDelay(page);
  await page.goto(post.url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const postText = await page.locator('[data-testid="tweetText"]').first().innerText({ timeout: 5000 }).catch(() => '');
  try {
    helper = await context.newPage();
    await helper.goto(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
    await page.bringToFront();
    // The extension itself injects its normal scripts only with previously granted site access.
    const tabId = await helper.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https:\/\/x\.com\//.test(tab.url || '')) throw new Error('未找到当前 X 标签页');
      const platform = globalThis.CommentCrate.platformsMeta.PLATFORMS.find(p => p.id === 'x');
      const perms = globalThis.CommentCrate.permissions.create(chrome);
      if (!await perms.has(platform)) throw new Error('CommentCrate 尚未获得 X 访问权限');
      try { await chrome.tabs.sendMessage(tab.id, { type: 'cc:status' }); }
      catch { await perms.inject(tab.id, platform); }
      return tab.id;
    });
    const status = () => helper.evaluate(id => chrome.tabs.sendMessage(id, { type: 'cc:status' }), tabId);
    const session = await context.newCDPSession(page);
    for (let attempt = 0; attempt < 2; attempt++) {
      await guard();
      if (attempt) {
        await actionDelay(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await helper.evaluate(async id => {
          const platform = globalThis.CommentCrate.platformsMeta.PLATFORMS.find(p => p.id === 'x');
          try { await chrome.tabs.sendMessage(id, { type: 'cc:status' }); }
          catch { await globalThis.CommentCrate.permissions.create(chrome).inject(id, platform); }
        }, tabId);
      }
      await page.waitForTimeout(1000);
      await actionDelay(page);
      await panelAction(session, 'open');
      await page.waitForTimeout(500);
      let current = await status();
      const expectedPostId = new URL(post.url).pathname.split('/').pop();
      const activeForPost = s => ['running', 'waiting_visible', 'done'].includes(s?.state) && s?.target?.code === expectedPostId;
      if (['running', 'waiting_visible', 'done'].includes(current?.state) && !activeForPost(current)) throw new Error('插件中已有其他帖子任务，未重复启动扫描');
      if (activeForPost(current)) break;
      try {
        await actionDelay(page);
        await panelAction(session, 'scan');
      } catch (error) {
        current = await status();
        if (activeForPost(current)) break;
        throw error;
      }
      for (let i = 0; i < 15; i++) {
        await guard();
        await page.waitForTimeout(1000);
        current = await status();
        if (current.state !== 'idle') break;
      }
      if (['running', 'waiting_visible', 'done'].includes(current?.state) && !activeForPost(current)) throw new Error('插件任务与目标帖子不一致');
      if (current?.state !== 'idle') break;
      if (!attempt) console.log('扫描没有反应，刷新页面后重试一次。');
      else throw new Error('两次点击 Scan 后扫描都没有启动。');
    }
    let current;
    for (let i = 0; i < 600; i++) {
      await guard();
      current = await status();
      if (current.state === 'done' || current.state === 'error') break;
      await page.waitForTimeout(1000);
    }
    if (current?.state !== 'done') throw new Error(`扫描未完成：${current?.error || current?.state || '状态不可用'}；请检查页面。`);
    if (!current.count) throw new Error('扫描结束但没有捕获评论，请检查页面。');
    await actionDelay(page);
    await panelAction(session, 'download');
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await actionDelay(page);
    await panelAction(session, 'csv');
    const file = await downloadPromise;
    const failure = await file.failure();
    if (failure) throw new Error(`下载失败：${failure}`);
    await mkdir(outputDir, { recursive: true });
    const id = new URL(post.url).pathname.split('/').pop();
    const destination = path.join(outputDir, `${id}-${Date.now()}.csv`);
    await file.saveAs(destination);
    return { destination, count: current.count, stoppedWhy: current.stoppedWhy, text: postText.trim().slice(0, 2000) };
  } finally { if (helper) await helper.close().catch(() => {}); }
}
