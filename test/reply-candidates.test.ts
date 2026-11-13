/** 验证回复 CSV 解析和候选筛选的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, collectCandidates, partitionReplyCandidates, parseCountValue, enrichCsv } from '../scripts/replies/reply-candidates.ts';

test('parses multiline CSV and merges authors across case and host', () => {
  const csv = '\uFEFFtext,profileUrl\r\n"hello,\n""world""",https://x.com/Hello\r\nSecond,https://twitter.com/HELLO\r\nno,https://evil.example/Hello\r\n';
  assert.deepEqual(collectCandidates(csv), [{ username: 'Hello', profileUrl: 'https://x.com/Hello', replies: ['hello,\n"world"', 'Second'] }]);
});

test('rejects malformed and incomplete exports', () => {
  assert.throws(() => parseCsv('a\n"unfinished'));
  assert.throws(() => collectCandidates('author,text\na,b'));
  assert.throws(() => collectCandidates('text,profileUrl\none'));
});

test('partitions Arabic replies without using profile location', () => {
  const csv = [
    'id,text,profileUrl,postUrl',
    '11,\u0645\u0631\u062d\u0628\u0627,https://x.com/Arabic,https://x.com/blogger/status/99',
    '12,hello,https://x.com/Plain,https://x.com/blogger/status/99',
    '99,post body,https://x.com/blogger,https://x.com/blogger/status/99',
  ].join('\n');
  const result = partitionReplyCandidates(csv, '99');
  assert.deepEqual(result.direct.map(c => c.username), ['Arabic']);
  assert.deepEqual(result.remaining.map(c => c.username), ['Plain']);
  assert.equal(result.hasFollowerCounts, false);
  assert.equal(result.hasUserIds, false);
});

test('reads followers and following counts from CommentCrate CSV', () => {
  assert.equal(parseCountValue('1,234'), 1234);
  assert.equal(parseCountValue('1.2K'), 1200);
  assert.equal(parseCountValue('3M'), 3000000);
  assert.equal(parseCountValue('2万'), 20000);
  assert.equal(parseCountValue(''), undefined);
  assert.equal(parseCountValue('n/a'), undefined);
  const csv = [
    'id,text,profileUrl,postUrl,authorId,followersCount,followingCount',
    '11,hello,https://x.com/A,https://x.com/blogger/status/99,111,"1,234",2K',
    '12,world,https://x.com/B,https://x.com/blogger/status/99,222,50,300',
    '13,again,https://x.com/A,https://x.com/blogger/status/99,111,"1,234",2K',
  ].join('\n');
  const result = partitionReplyCandidates(csv, '99');
  assert.equal(result.hasFollowerCounts, true);
  assert.equal(result.hasUserIds, true);
  const a = result.remaining.find(c => c.username === 'A');
  const b = result.remaining.find(c => c.username === 'B');
  assert.deepEqual([a.followers, a.following, a.replies.length, a.userId], [1234, 2000, 2, '111']);
  assert.deepEqual([b.followers, b.following, b.userId], [50, 300, '222']);
});

test('recognizes author-prefixed count headers', () => {
  const csv = [
    'id,text,profileUrl,postUrl,authorFollowers,authorFollowing',
    '21,hello,https://x.com/C,https://x.com/blogger/status/99,80,90',
  ].join('\n');
  const result = partitionReplyCandidates(csv, '99');
  assert.equal(result.hasFollowerCounts, true);
  assert.deepEqual([result.remaining[0].followers, result.remaining[0].following], [80, 90]);
});

test('writes followers and following back into the CSV', () => {
  const csv = [
    'id,text,profileUrl,postUrl',
    '11,hello,https://x.com/A,https://x.com/blogger/status/99',
    '12,world,https://x.com/B,https://x.com/blogger/status/99',
  ].join('\n');
  const rows = parseCsv(enrichCsv(csv, { a: { followers: 80, following: 90 } }));
  assert.deepEqual(rows[0], ['id', 'text', 'profileUrl', 'postUrl', 'followersCount', 'followingCount']);
  assert.deepEqual(rows[1], ['11', 'hello', 'https://x.com/A', 'https://x.com/blogger/status/99', '80', '90']);
  assert.deepEqual(rows[2].slice(4), ['', '']);
});
