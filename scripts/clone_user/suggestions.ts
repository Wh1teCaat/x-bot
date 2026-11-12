import type { Page } from 'playwright';

/** Click the first username option explicitly grouped as a suggestion on X. */
export async function chooseFirstSuggestion(page: Page, original: string, owner: string): Promise<string> {
  const groups = page.locator('[data-testid="username-suggestions"], [data-testid="suggestedUsernames"], [data-testid="usernameSuggestions"]');
  const heading = page.getByText(/^(suggestions?|suggested usernames?|available usernames?|推荐用户名|建议的用户名|建议用户名|可用的用户名|推荐|建议)\s*[:：]?$/i).first();
  let group = groups.first();
  if (!await group.isVisible().catch(() => false)) {
    await heading.waitFor({ state: 'visible', timeout: 10000 });
    group = heading.locator('xpath=..');
  }
  const options = group.locator('button, [role="button"], [role="option"], [data-testid="usernameSuggestion"]');
  const count = await options.count();
  for (let index = 0; index < count; index++) {
    const option = options.nth(index);
    if (!await option.isVisible().catch(() => false)) continue;
    const label = (await option.innerText()).trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{4,15}$/.test(label)) continue;
    if ([original.toLowerCase(), owner.toLowerCase(), 'cancel', 'save', 'back', 'next', 'done', 'close'].includes(label.toLowerCase())) continue;
    await option.click();
    return label;
  }
  throw new Error('未找到明确标记的用户名建议，请在 X 页面检查；未修改用户名');
}
