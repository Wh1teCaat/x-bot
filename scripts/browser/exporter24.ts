import '../../src/runtime-config.ts';
/** 使用 exporter24 扩展的搜索页读取用户的关注/粉丝数。 */
import type { BrowserContext, Download, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { profileCountsFromText, type ProfileCounts } from '../replies/profile-counts.ts';
import { ExporterTransientError } from './exporter-retry.ts';

export const EXPORTER24_EXTENSION_ID =
  process.env.X_EXPORTER24_EXTENSION_ID || 'ebcejikneofoobengkjlojmbohgjacne';
/** exporter24 网页与登录接口；扩展的 “sign with token” 也走这个接口。 */
export const EXPORTER24_WEB_HOST = process.env.X_EXPORTER24_WEB_HOST || 'https://www.exporter24.net';
/** 扩展把登录账号写在 chrome.storage.sync 的这个键（0.3.5 版 saveUserInfo）。 */
export const EXPORTER24_USER_KEY = 'webUserInfo';
export type Exporter24User = { name: string; email: string; avatar: string; token: string };
/** 免费额度用完后扩展会要求 5 星评价；登录页和额度弹窗同样需要处理。 */
export type Exporter24Gate = 'review' | 'signin' | 'credits';

/** 识别 exporter24 的 5 星评价、登录和额度门槛；返回 null 表示没有门槛。 */
export function exporter24Gate(text: string): Exporter24Gate | null {
  if (/5[-\s]?star|leave us a .{0,40}review|special offer/i.test(text)) return 'review';
  if (/insufficient credits|buy credits/i.test(text)) return 'credits';
  if (/sign in\s*\/\s*sign up|invalid auth token|please sign in/i.test(text)) return 'signin';
  return null;
}

/** 读取扩展页当前显示的门槛；页面不可用（例如测试替身）时按无门槛处理。 */
export async function readExporter24Gate(page: Page): Promise<Exporter24Gate | null> {
  try {
    return exporter24Gate(await page.locator('body').innerText({ timeout: 3000 }));
  } catch {
    return null;
  }
}

/** 从扩展存储读取已登录账号；未登录或页面不可用时返回 null。 */
export async function readExporter24User(page: Page): Promise<Exporter24User | null> {
  try {
    const user = await page.evaluate(async (key) => {
      const chrome = (globalThis as any).chrome;
      if (!chrome?.storage?.sync) return null;
      const stored = await chrome.storage.sync.get(key);
      return stored?.[key] ?? null;
    }, EXPORTER24_USER_KEY) as Exporter24User | null;
    return user && typeof user.token === 'string' && user.token ? user : null;
  } catch {
    return null;
  }
}

/**
 * 用 .env 的 X_EXPORT_TOKEN 通过 exporter24 官方 /api/user 换取扩展会话。
 * 与扩展 “sign with token” 一致：请求体是登录码，响应里的 token 才是会话令牌。
 */
export async function exchangeExporter24Token(code: string): Promise<Exporter24User> {
  const loginCode = code.trim();
  if (!loginCode) throw new Error('缺少 X_EXPORT_TOKEN');
  let response: Response;
  try {
    response = await fetch(`${EXPORTER24_WEB_HOST}/api/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: loginCode }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ExporterTransientError('无法连接 exporter24 登录接口', error);
  }
  if (response.status === 429 || response.status >= 500) throw new ExporterTransientError(`exporter24 登录接口暂不可用（HTTP ${response.status}）`, undefined, response.status);
  const body = await response.json().catch(() => null) as
    { token?: unknown; user?: { name?: string; email?: string; image?: string } } | null;
  const email = body?.user?.email;
  if (!response.ok || typeof body?.token !== 'string' || !body.token || typeof email !== 'string' || !email) {
    throw new Error(`exporter24 登录失败（HTTP ${response.status}）`);
  }
  return {
    name: body.user?.name || email.split('@')[0],
    email,
    avatar: body.user?.image || '',
    token: body.token,
  };
}

/** 把账号写入扩展存储并重新加载扩展页，等价于扩展的 “sign with token” 登录。 */
export async function loginExporter24(page: Page, user: Exporter24User): Promise<void> {
  await page.evaluate(async ({ key, value }) => {
    const chrome = (globalThis as any).chrome;
    if (!chrome?.storage?.sync) throw new Error('扩展存储不可用');
    await chrome.storage.sync.set({ [key]: value });
  }, { key: EXPORTER24_USER_KEY, value: user });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  const stored = await readExporter24User(page);
  if (stored?.token !== user.token) throw new Error('exporter24 登录未生效');
}

/** 每个页面首次使用前用配置的令牌登录；出现门槛时重新登录。 */
const authenticatedPages = new WeakMap<Page, { code: string; session: string }>();
export async function ensureExporter24Auth(
  page: Page,
  guard: () => void | Promise<void> = () => {},
  options: { token?: string; exchange?: (code: string) => Promise<Exporter24User> } = {},
): Promise<'already' | 'logged-in'> {
  const gate = await readExporter24Gate(page);
  const token = (options.token ?? process.env.X_EXPORT_TOKEN ?? '').trim();
  if (!token && !gate) return 'already';
  if (!token) {
    const reason = gate === 'review' ? '要求 5 星评价' : gate === 'credits' ? '额度不足' : '需要登录';
    throw new Error(`exporter24 ${reason}；请在 .env 配置 X_EXPORT_TOKEN 以自动登录`);
  }
  const cached = authenticatedPages.get(page);
  if (!gate && cached?.code === token && (await readExporter24User(page))?.token === cached.session) return 'already';
  await guard();
  const user = await (options.exchange ?? exchangeExporter24Token)(token);
  const current = await readExporter24User(page);
  if (gate || current?.token !== user.token) await loginExporter24(page, user);
  authenticatedPages.set(page, { code: token, session: user.token });
  console.log('exporter24 已用 X_EXPORT_TOKEN 登录。');
  return 'logged-in';
}

/** 在已有浏览器上下文里打开 exporter24 页面；未安装时返回 null。 */
export async function openExporter24(context: BrowserContext, options: { throwOnLoadedError?: boolean } = {}): Promise<Page | null> {
  let page: Page | undefined;
  let loaded = false;
  try {
    page = await context.newPage();
    await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    loaded = true;
    await ensureExporter24Auth(page);
    await page.locator('input').first().waitFor({ state: 'visible', timeout: 10000 });
    return page;
  } catch (error) {
    await page?.close().catch(() => {});
    if (loaded && options.throwOnLoadedError) throw error;
    // 文件存在并不代表 Chrome 已加载扩展；保留导航失败信息以便检查禁用或注册异常。
    console.warn(`exporter24 ${loaded ? '页面不可用' : '扩展页无法打开（可能未加载或被 Chrome 禁用）'}：${error instanceof Error ? error.message : error}`);
    return null;
  }
}

async function readCountsOnce(
  page: Page,
  username: string,
  guard: () => void | Promise<void>,
): Promise<ProfileCounts> {
  await guard();
  await page.bringToFront();
  const input = page.locator('input').first();
  await input.fill('');
  await input.fill(username);
  await input.press('Enter');
  // 等结果卡片切换到当前用户名，避免读到上一个用户的旧计数。
  await page.getByText(new RegExp(`@${username}\\b`, 'i')).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const followers = page.getByRole('button', { name: /^Followers:/ }).first();
  const following = page.getByRole('button', { name: /^Following:/ }).first();
  await Promise.race([
    followers.waitFor({ state: 'visible', timeout: 15000 }),
    following.waitFor({ state: 'visible', timeout: 15000 }),
  ]).catch(() => {});
  await guard();
  const [followersText, followingText] = await Promise.all([
    followers.innerText({ timeout: 3000 }).catch(() => ''),
    following.innerText({ timeout: 3000 }).catch(() => ''),
  ]);
  if (!followersText && !followingText) {
    const error = await page.getByText(/rate limit|too many|try again|failed|error/i).first().innerText({ timeout: 1000 }).catch(() => '');
    throw new Error(error ? `exporter24：${error}` : 'exporter24 未返回关注/粉丝数');
  }
  return profileCountsFromText(followersText, followingText);
}

/**
 * 在 exporter24 搜索框输入用户名并读取结果卡片上的两个计数。
 * 扩展未登录或查询失败时会抛出错误；调用者决定是否回退。
 */
export async function readExporter24Counts(
  page: Page,
  username: string,
  guard: () => void | Promise<void> = () => {},
): Promise<ProfileCounts> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('用户名无效');
  await ensureExporter24Auth(page, guard);
  try {
    return await readCountsOnce(page, username, guard);
  } catch (error) {
    // 搜索过程中才弹出 5 星评价/登录门槛时，登录后重试一次当前用户。
    if (!await readExporter24Gate(page)) throw error;
    await ensureExporter24Auth(page, guard);
    return readCountsOnce(page, username, guard);
  }
}

async function exportFollowersOnce(
  page: Page,
  username: string,
  outputDir: string,
  guard: () => void | Promise<void>,
): Promise<{ destination: string }> {
  await guard();
  await page.bringToFront();
  const input = page.locator('input').first();
  await input.fill('');
  await input.fill(username);
  await input.press('Enter');
  await page.getByText(new RegExp(`@${username}\\b`, 'i')).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const button = page.getByRole('button', { name: /^Followers:/ }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  const timeout = Math.max(30000, Number(process.env.FOLLOWER_EXPORT_TIMEOUT_MS) || 600000);
  const context = page.context();
  let settled = false;
  const downloadPromise = new Promise<Download>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exporter24 粉丝导出超时（可能需要登录/额度，或账号粉丝过多）')), timeout);
    const onDownload = (item: Download) => { settled = true; clearTimeout(timer); resolve(item); };
    page.once('download', onDownload);
    context.once('page', (newPage) => newPage.once('download', onDownload));
  });
  void downloadPromise.catch(() => {});
  await button.click();
  // 任务页有时间统计；等 Total 出现，0 粉丝时直接报错，避免空等。
  let total: number | null = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText().catch(() => '');
    const match = text.match(/Total\s*[:：]\s*([\d,]+)/i);
    if (match) { total = Number(match[1].replace(/,/g, '')); break; }
    if (exporter24Gate(text)) throw new Error('exporter24 需要登录或额度，无法导出粉丝');
    await page.waitForTimeout(1000);
  }
  if (total === null) throw new Error('exporter24 粉丝任务没有返回总数（可能需要登录/额度）');
  if (total === 0) throw new Error(`@${username} 没有可导出的粉丝`);
  const exportAll = page.getByRole('button', { name: /^Export All$/i }).first();
  await exportAll.waitFor({ state: 'visible', timeout: 15000 });
  for (let attempt = 0; attempt < 60 && !await exportAll.isEnabled().catch(() => false); attempt++) await page.waitForTimeout(500);
  if (!await exportAll.isEnabled().catch(() => false)) throw new Error('exporter24 的 Export All 不可用');
  if (!settled) await exportAll.click();
  const download = await downloadPromise;
  const destination = join(outputDir, `followers-${username}-${Date.now()}.csv`);
  await mkdir(outputDir, { recursive: true });
  await download.saveAs(destination);
  return { destination };
}

/** 点击 exporter24 的 Followers 按钮，等待任务完成后导出粉丝 CSV。 */
export async function exportExporter24Followers(
  page: Page,
  username: string,
  outputDir: string,
  guard: () => void | Promise<void> = () => {},
): Promise<{ destination: string }> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('用户名无效');
  await ensureExporter24Auth(page, guard);
  try {
    return await exportFollowersOnce(page, username, outputDir, guard);
  } catch (error) {
    if (!await readExporter24Gate(page)) throw error;
    await ensureExporter24Auth(page, guard);
    return exportFollowersOnce(page, username, outputDir, guard);
  }
}
