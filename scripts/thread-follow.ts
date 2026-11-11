/** 保留原帖回复菜单的浏览器关注实现，供旧流程参考。 */
import { actionDelay } from './action-delay.ts';

// Only interact with a reply whose timestamp URL matches the exported reply ID
// and author. The page can contain unrelated recommendations and quoted posts.
/** 仅在用户名和回复 ID 均匹配时认定为候选回复。 */
export function matchThreadReply(path, candidate) {
  if (typeof path !== 'string' || !candidate || !Array.isArray(candidate.replyIds)) return false;
  const match = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,19})\/?$/);
  return !!match && match[1].toLowerCase() === candidate.username.toLowerCase() && candidate.replyIds.includes(match[2]);
}

/** 在原帖中查找目标回复、关注并持久化每次确认结果。 */
export async function followFromThread(page, post, candidates, store, save, guard = () => {}, { maxNewFollows = Infinity, expectedAccount = null } = {}) {
  if (!candidates.length) return { matched: [], unresolved: [] };
  await actionDelay(page);
  await page.goto(post.url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('tweet').first().waitFor({ state: 'visible', timeout: 30000 });
  const accountLink = page.getByTestId('AppTabBar_Profile_Link');
  const accountHref = await accountLink.getAttribute('href', { timeout: 15000 });
  if (!/^\/[A-Za-z0-9_]{1,15}$/.test(accountHref || '')) throw new Error('无法确认当前登录账号');
  const account = accountHref.slice(1).toLowerCase();
  if (expectedAccount && account !== expectedAccount.toLowerCase()) throw new Error('登录账号与本轮已处理的账号不同');
  const remaining = new Map();
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate.username) || !candidate.replyIds?.every(id => /^\d{1,19}$/.test(id))) throw new Error('候选用户或回复 ID 无效');
    const key = candidate.username.toLowerCase();
    if (key !== account) remaining.set(key, candidate);
  }
  const matched = [];
  let stagnant = 0, moves = 0;
  const seenReplies = new Set();
  const seenUsers = new Set();
  while (remaining.size && moves < 100 && stagnant < 6) {
    await guard();
    const cards = page.getByTestId('tweet');
    const before = seenReplies.size;
    const length = await cards.count();
    for (let i = 0; i < length && remaining.size; i++) {
      await guard();
      const card = cards.nth(i);
      // Timeline cards can disappear or be recycled while the list changes.
      const href = await card.locator('a:has(time)').first().getAttribute('href', { timeout: 1000 }).catch(() => null);
      if (!href) continue;
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,19})\/?$/);
      if (!m) continue;
      seenReplies.add(m[2]);
      const key = m[1].toLowerCase();
      if (!seenUsers.has(key)) {
        seenUsers.add(key);
        if (seenUsers.size % 10 === 0) await page.waitForTimeout(Math.floor(Math.random() * 5001));
      }
      const candidate = remaining.get(key);
      if (!candidate || !matchThreadReply(href, candidate)) continue;
      console.log(`匹配回复 @${candidate.username}，正在核对关注状态。`);
      // React can reorder or replace cards after a follow. Never keep nth(i)
      // as the target: re-resolve the exact timestamp link on every interaction.
      const stableCard = page.getByTestId('tweet').filter({ has: page.locator(`a[href="${href}"] time`) });
      if (await stableCard.count() !== 1) throw new Error(`无法唯一定位 @${candidate.username} 的回复`);
      const userName = stableCard.getByTestId('User-Name').first();
      const authorHref = await userName.locator('a').first().getAttribute('href').catch(() => null);
      if (authorHref?.toLowerCase() !== `/${key}`) throw new Error(`无法核对 @${candidate.username} 的回复作者`);
      if ((await accountLink.getAttribute('href', { timeout: 15000 }))?.toLowerCase() !== `/${account}`) throw new Error('登录账号已变化，停止关注');
      const previous = store.status(account, key);
      if (previous) {
        if (previous === 'uncertain') throw new Error(`@${candidate.username} 之前的关注结果不明确，请先人工核实`);
        matched.push({ username: candidate.username, status: previous });
        remaining.delete(key); await save({ matched, unresolved: [...remaining.keys()] }); continue;
      }
      const caret = stableCard.getByTestId('caret').first();
      await actionDelay(page); await caret.click({ timeout: 10000 });
      const name = candidate.username;
      const following = page.getByRole('menuitem', { name: new RegExp(`^(Unfollow|取消关注) @${name}$`, 'i') });
      const pending = page.getByRole('menuitem', { name: new RegExp(`^(Cancel follow request|取消关注请求) @${name}$`, 'i') });
      if (await following.isVisible().catch(() => false) || await pending.isVisible().catch(() => false)) {
        const status = await following.isVisible().catch(() => false) ? 'following' : 'pending';
        store.record(account, key, status);
        await actionDelay(page); await page.keyboard.press('Escape');
        matched.push({ username: name, status }); remaining.delete(key);
        await save({ matched, unresolved: [...remaining.keys()] }); continue;
      }
      const button = page.getByRole('menuitem', { name: new RegExp(`^(Follow|关注) @${name}$`, 'i') });
      if (await button.count() !== 1 || !await button.isVisible()) throw new Error(`无法唯一识别 @${name} 的关注菜单`);
      if (!store.reserve(account, key)) throw new Error(`@${name} 已被其他任务处理，请先核实`);
      await actionDelay(page);
      await guard();
      await button.click({ timeout: 10000 });
      await guard();
      // Reopening this exact reply menu checks whether the relationship changed.
      await actionDelay(page);
      await caret.click({ timeout: 10000 });
      let status;
      try { await following.or(pending).first().waitFor({ state: 'visible', timeout: 8000 }); }
      catch { throw new Error(`@${name} 关注结果无法确认，已记录 uncertain`); }
      if (await following.isVisible().catch(() => false)) status = 'following';
      else if (await pending.isVisible().catch(() => false)) status = 'pending';
      else throw new Error(`@${name} 关注结果无法确认，已记录 uncertain`);
      store.record(account, key, status);
      await actionDelay(page); await page.keyboard.press('Escape');
      matched.push({ username: name, status }); remaining.delete(key);
      await save({ matched, unresolved: [...remaining.keys()] });
      console.log(`@${name}：${status}；剩余 ${remaining.size} 人。`);
      if (--maxNewFollows === 0) return { matched, unresolved: [...remaining.keys()], probeSucceeded: true };
    }
    stagnant = seenReplies.size === before ? stagnant + 1 : 0;
    if (remaining.size) {
      console.log(`已扫描 ${seenReplies.size} 条回复，剩余 ${remaining.size} 人；继续滚动（${moves + 1}/100）。`);
      await actionDelay(page); await page.mouse.wheel(0, 1200); await page.waitForTimeout(1800); moves++;
    }
  }
  const unresolved = [...remaining.keys()];
  await save({ matched, unresolved });
  return { matched, unresolved };
}
