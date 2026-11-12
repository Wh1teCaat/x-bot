/** 验证API 授权账号选择、用户解析和关注断点的行为与边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFollowClient, followCandidatesApi } from '../scripts/follow/api-follow.ts';

test('pins authorization and resolves usernames in a batch', async () => {
  const calls = [];
  const client = new LocalFollowClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const value = url.endsWith('/api/accounts') ? { accounts: [{ user: { id: '1', username: 'me' }, scope: 'users.read follows.write' }] } : { data: [{ id: '22', username: 'Alice' }] };
    return new Response(JSON.stringify(value));
  } });
  assert.equal((await client.selectAccount()).id, '1');
  assert.deepEqual(await client.lookup('1', [{ username: 'alice' }]), { alice: '22' });
  assert.match(calls[1].url, /users\/by\?usernames=alice/);
});

test('follows resolved IDs, persists progress and half-open makes at most one new request', async () => {
  const calls = [], saves = [];
  const client = { follow: async (account, target) => { calls.push([account, target]); return { data: { following: true } }; } };
  const candidates = [{ username: 'A' }, { username: 'B' }, { username: 'missing' }];
  const result = await followCandidatesApi({ client, accountId: '1', candidates, ids: { a: '2', b: '3' }, save: async value => saves.push(value), maxNewFollows: 1 });
  assert.deepEqual(calls, [['1', '2']]);
  assert.deepEqual(result.unresolved, ['b', 'missing']);
  assert.equal(result.probeSucceeded, true); assert.equal(saves.length, 1);
});

test('does not repeat persisted users and reports unresolved names', async () => {
  const calls = [];
  const result = await followCandidatesApi({ client: { follow: async (...args) => { calls.push(args); return { data: { pending_follow: true } }; } }, accountId: '1', candidates: [{ username: 'A' }, { username: 'B' }, { username: 'C' }], ids: { a: '2', b: '3' }, progress: { matched: [{ username: 'A', status: 'following' }] }, save: async () => {} });
  assert.deepEqual(calls, [['1', '3']]); assert.deepEqual(result.unresolved, ['c']);
  assert.equal(result.matched[1].status, 'pending');
});
