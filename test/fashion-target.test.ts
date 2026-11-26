/** 验证自动选择时尚博主的粉丝和回复阈值。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverFashionTarget, evaluateFashionCandidate, parseFashionQueries } from '../scripts/clone_user/fashion-target.ts';

const base = { minFollowers: 1000, minReplies: 50, requiredPosts: 2 };

test('requires followers above 1000 and 2 of the latest 3 posts at 50+ replies', () => {
  assert.equal(evaluateFashionCandidate({ ...base, followers: 1001, replyCounts: [50, 80, 0] }).pass, true);
  assert.equal(evaluateFashionCandidate({ ...base, followers: 1000, replyCounts: [50, 80, 0] }).pass, false);
  assert.equal(evaluateFashionCandidate({ ...base, followers: 5000, replyCounts: [49, 100, 100] }).pass, true);
  assert.equal(evaluateFashionCandidate({ ...base, followers: 5000, replyCounts: [10, 20, 30] }).pass, false);
  assert.equal(evaluateFashionCandidate({ ...base, followers: 5000, replyCounts: [50, 60] }).pass, false);
});

test('parses configured fashion search queries', () => {
  assert.deepEqual(parseFashionQueries('fashion, ootd, bad!'), ['fashion', 'ootd']);
  assert.deepEqual(parseFashionQueries(undefined), ['fashion', 'fashion blogger', 'fashion influencer', 'ootd', 'street style']);
});

test('skips assigned targets and continues if another child claims a candidate during evaluation', async () => {
  const timelineIds: string[] = [];
  const chosen = await discoverFashionTarget({
    accountId: '1', origin: 'http://127.0.0.1:3000', queries: ['fashion'],
    isAvailable: candidate => candidate.id !== '11',
    reserve: candidate => candidate.id !== '12',
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/search')) return Response.json({ data: ['11', '12', '13'].map(id => ({
        id, username: `target${id}`, public_metrics: { followers_count: 2000 },
      })) });
      timelineIds.push(path.split('/').at(-2)!);
      return Response.json({ data: [60, 60, 0].map(reply_count => ({ public_metrics: { reply_count } })) });
    },
  });
  assert.equal(chosen, 'target13');
  assert.deepEqual(timelineIds, ['12', '13']);
});
