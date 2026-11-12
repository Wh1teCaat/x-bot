/** 验证回复 CSV 解析和候选筛选的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, collectCandidates } from '../scripts/replies/reply-candidates.ts';

test('parses multiline CSV and merges authors across case and host', () => {
  const csv = '\uFEFFtext,profileUrl\r\n"hello,\n""world""",https://x.com/Hello\r\nSecond,https://twitter.com/HELLO\r\nno,https://evil.example/Hello\r\n';
  assert.deepEqual(collectCandidates(csv), [{ username: 'Hello', profileUrl: 'https://x.com/Hello', replies: ['hello,\n"world"', 'Second'] }]);
});

test('rejects malformed and incomplete exports', () => {
  assert.throws(() => parseCsv('a\n"unfinished'));
  assert.throws(() => collectCandidates('author,text\na,b'));
  assert.throws(() => collectCandidates('text,profileUrl\none'));
});

test('prioritizes matching replies only among profiles with Saudi location evidence', async () => {
  const { hasSaudiLocation, rankCandidates } = await import('../scripts/replies/reply-candidates.ts');
  assert.equal(hasSaudiLocation('Riyadh, Saudi Arabia'), true);
  assert.equal(hasSaudiLocation('الرياض'), true);
  assert.equal(hasSaudiLocation('Paris'), false);
  assert.equal(hasSaudiLocation(''), false);
  const ranked = rankCandidates([
    { username: 'first', location: 'جدة', replies: ['hello'] },
    { username: 'unknown', location: '', replies: ['Saudi'] },
    { username: 'match', location: 'Riyadh', replies: ['SAUDI news'] },
  ], ['saudi']);
  assert.deepEqual(ranked.map(x => x.username), ['match', 'first']);
  assert.deepEqual(ranked[0].matchedKeywords, ['saudi']);
});
