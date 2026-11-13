import type { Page } from 'playwright';
import { actionDelay } from '../browser/action-delay.ts';

/** Click the first username suggestion that reflects the typed handle, waiting for X to refresh them. */
export async function chooseFirstSuggestion(page: Page, original: string, owner: string): Promise<string> {
  const groups = page.locator('[data-testid="username-suggestions"], [data-testid="suggestedUsernames"], [data-testid="usernameSuggestions"]');
  const heading = page.getByText(/^(suggestions?|suggested usernames?|available usernames?|推荐用户名|建议的用户名|建议用户名|可用的用户名|推荐|建议)\s*[:：]?$/i).first();
  let group = groups.first();
  if (!await group.isVisible().catch(() => false)) {
    await heading.waitFor({ state: 'visible', timeout: 10000 });
    // 设置页把建议列表和标题放在同一个 section 里，标题自身不带 data-testid。
    const section = heading.locator('xpath=ancestor::section[1]');
    group = await section.count() ? section.first() : heading.locator('xpath=..');
  }
  const options = group.locator('button, [role="button"], [role="option"], [data-testid="usernameSuggestion"]');
  const skip = new Set([original.toLowerCase(), owner.toLowerCase(), 'cancel', 'save', 'back', 'next', 'done', 'close', 'more', 'browse', 'settings']);
  const collect = async () => {
    const found: { index: number; label: string }[] = [];
    const count = await options.count();
    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      if (!await option.isVisible().catch(() => false)) continue;
      const label = (await option.innerText()).trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{4,15}$/.test(label)) continue;
      if (skip.has(label.toLowerCase())) continue;
      found.push({ index, label });
    }
    return found;
  };
  // 刚输入新名字时，列表可能还停留在旧用户的建议上；等出现与新名字同前缀的建议再点。
  const prefix = original.slice(0, Math.min(4, original.length)).toLowerCase();
  let found = await collect();
  for (let attempt = 0; attempt < 15 && !found.some(item => item.label.toLowerCase().startsWith(prefix)); attempt++) {
    await page.waitForTimeout(400);
    found = await collect();
  }
  const chosen = found.find(item => item.label.toLowerCase().startsWith(prefix)) ?? found[0];
  if (!chosen) throw new Error('未找到明确标记的用户名建议，请在 X 页面检查；未修改用户名');
  await actionDelay(page);
  await options.nth(chosen.index).click();
  return chosen.label;
}
