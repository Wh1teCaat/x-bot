/** 使用 exporter24 扩展的搜索页读取用户的关注/粉丝数。 */
import type { BrowserContext, Page } from 'playwright';
import { profileCountsFromText, type ProfileCounts } from '../replies/profile-counts.ts';

export const EXPORTER24_EXTENSION_ID =
  process.env.X_EXPORTER24_EXTENSION_ID || 'ebcejikneofoobengkjlojmbohgjacne';

/** 在已有浏览器上下文里打开 exporter24 页面；未安装时返回 null。 */
export async function openExporter24(context: BrowserContext): Promise<Page | null> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await page.locator('input').first().waitFor({ state: 'visible', timeout: 10000 });
    return page;
  } catch {
    await page?.close().catch(() => {});
    return null;
  }
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
