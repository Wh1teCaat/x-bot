/** 验证帖子按新到旧排序。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortPostsNewestFirst } from '../scripts/replies/post-order.ts';

test('sorts posts newest first even with a pinned old post', () => {
  const posts = [
    { url: 'https://x.com/a/status/100', replies: 1 },
    { url: 'https://x.com/a/status/300', replies: 2 },
    { url: 'https://x.com/a/status/200', replies: 3 },
  ];
  assert.deepEqual(sortPostsNewestFirst(posts).map((p) => p.url), [
    'https://x.com/a/status/300',
    'https://x.com/a/status/200',
    'https://x.com/a/status/100',
  ]);
});
