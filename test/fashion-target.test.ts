/** 验证自动选择时尚博主的粉丝和回复阈值。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFashionCandidate, parseFashionQueries } from '../scripts/clone_user/fashion-target.ts';

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
