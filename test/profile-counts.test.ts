/** 验证主页关注/粉丝数文本解析。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileCount, profileCountsFromText, readProfileCounts } from '../scripts/replies/profile-counts.ts';

test('parses counts from profile link text', () => {
  assert.equal(parseProfileCount('1,234 Followers'), 1234);
  assert.equal(parseProfileCount('1.2K Followers'), 1200);
  assert.equal(parseProfileCount('3M following'), 3000000);
  assert.equal(parseProfileCount('2万 粉丝'), 20000);
  assert.equal(parseProfileCount('0 Followers'), 0);
  assert.equal(parseProfileCount('Followers'), undefined);
  assert.equal(parseProfileCount(''), undefined);
});

test('keeps each missing count independent', () => {
  assert.deepEqual(profileCountsFromText('80 Followers', '90 Following'), { followers: 80, following: 90 });
  assert.deepEqual(profileCountsFromText('Followers', '90 Following'), { followers: undefined, following: 90 });
});

test('reads counts from a profile page', async () => {
  const page = {
    goto: async (url: string) => { assert.equal(url, 'https://x.com/alice'); },
    getByTestId: () => ({ first: () => ({ waitFor: async () => {} }) }),
    locator: (selector: string) => ({ first: () => ({
      count: async () => 1,
      innerText: async () => selector.includes('/following') ? '90 Following' : '80 Followers',
    }) }),
    waitForTimeout: async () => {},
  };
  assert.deepEqual(await readProfileCounts(page as any, 'alice'), { followers: 80, following: 90 });
});
