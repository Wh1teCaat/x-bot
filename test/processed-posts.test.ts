import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ProcessedPosts, postId } from '../scripts/loop/processed-posts.ts';

test('历史只导入该账号真正完成的帖子，按帖子 ID 去重', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, state TEXT)');
  const result = (id: string, extra = {}) => ({ phase: 'replies', post: { url: `https://x.com/alice/status/${id}` }, export: {}, qualify: {}, follow: { unresolved: [] }, ...extra });
  const insert = db.prepare('INSERT INTO runs VALUES (?,?)');
  insert.run('a', JSON.stringify({ followAccountId: '1', results: [result('10'), result('11', { follow: { unresolved: ['bob'] } }), result('12', { followSkipped: true }), result('13', { phase: 'followers' })] }));
  insert.run('b', JSON.stringify({ followAccountId: '2', results: [result('20')] }));
  insert.run('c', '{');
  const history = new ProcessedPosts(db);
  history.importHistory('1');
  assert.equal(history.has('1', 'https://twitter.com/renamed/status/10?s=20'), true);
  for (const id of ['11', '12', '13', '20']) assert.equal(history.has('1', `https://x.com/alice/status/${id}`), false);
  assert.equal(history.has('2', 'https://x.com/alice/status/10'), false);
  history.mark('2', 'https://x.com/alice/status/10', 'new');
  assert.equal(history.has('2', 'https://x.com/alice/status/10'), true);
  assert.equal(postId('https://example.com/alice/status/10'), null);
  db.close();
});
