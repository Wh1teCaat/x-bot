/** 在浏览器中打开用户主页，读取公开的关注数和粉丝数。 */
import type { Page } from 'playwright';

/** 从主页文本中提取计数，例如 "1,234 Followers"、"1.2K 关注"。 */
export function parseProfileCount(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  let value = text.normalize('NFKC').trim();
  if (!value) return undefined;
  value = value
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const match = value.match(/([\d.,]+)\s*([KMB万千]?)/i);
  if (!match) return undefined;
  const unit = match[2].toLocaleLowerCase();
  const raw = match[1];
  const numeric = parseFloat(unit ? raw.replace(/,/g, '.') : raw.replace(/[.,]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  const factor = { k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '千': 1e3 }[unit] || 1;
  return Math.round(numeric * factor);
}

export type ProfileCounts = { followers?: number; following?: number };

/** 分别解析粉丝数和关注数文本，保留无法识别的字段为 undefined。 */
export function profileCountsFromText(followersText: unknown, followingText: unknown): ProfileCounts {
  return {
    followers: parseProfileCount(followersText),
    following: parseProfileCount(followingText),
  };
}

/**
 * 打开一个用户主页并读取粉丝/关注数。
 * 调用者负责相邻访问之间的延迟和限流检查。
 */
export async function readProfileCounts(page: Page, username: string, guard: () => void | Promise<void> = () => {}): Promise<ProfileCounts> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('用户名无效');
  await guard();
  await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('UserName').first().waitFor({ state: 'visible', timeout: 15000 });
  await guard();
  const followers = page.locator('a[href$="/followers"], a[href$="/followers/"]').first();
  const following = page.locator('a[href$="/following"], a[href$="/following/"]').first();
  let counts: ProfileCounts = {};
  for (let attempt = 0; attempt < 6; attempt++) {
    const [followersText, followingText] = await Promise.all([
      followers.count().then(count => count ? followers.innerText({ timeout: 1000 }).catch(() => '') : ''),
      following.count().then(count => count ? following.innerText({ timeout: 1000 }).catch(() => '') : ''),
    ]);
    counts = profileCountsFromText(followersText, followingText);
    if (counts.followers !== undefined && counts.following !== undefined) break;
    await page.waitForTimeout(400);
  }
  return counts;
}
