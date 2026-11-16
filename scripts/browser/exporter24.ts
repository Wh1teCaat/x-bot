/** 使用 exporter24 扩展的搜索页读取用户的关注/粉丝数。 */
import type { BrowserContext, Download, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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

/** 点击 exporter24 的 Followers 按钮，等待任务完成后导出粉丝 CSV。 */
export async function exportExporter24Followers(
  page: Page,
  username: string,
  outputDir: string,
  guard: () => void | Promise<void> = () => {},
): Promise<{ destination: string }> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('用户名无效');
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
    if (/Sign in|insufficient|credits|额度|登录/i.test(text)) throw new Error('exporter24 需要登录或额度，无法导出粉丝');
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
