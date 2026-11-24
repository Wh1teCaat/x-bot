import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FollowerCheckpoints, FOLLOWER_INTERVAL_MS, readFollowerBatch, selectFollowerHistory, FollowerHistoryError } from '../scripts/browser/follower-batch.ts';
import { parseLoopArguments } from '../scripts/loop/loop-arguments.ts';

test('checkpoint isolates accounts and targets and preserves due time and completion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const checkpoints = new FollowerCheckpoints(db);
    const value = { taskId: 'history-1', offset: 200, due: 1000 + FOLLOWER_INTERVAL_MS, done: false };
    checkpoints.save('1', 'Alice', value);
    assert.deepEqual(new FollowerCheckpoints(db).get('1', 'alice'), value);
    assert.equal(checkpoints.get('2', 'alice').offset, 0);
    assert.equal(checkpoints.get('1', 'bob').offset, 0);
    checkpoints.save('1', 'alice', { ...value, offset: 225, done: true });
    assert.equal(checkpoints.get('1', 'alice').done, true);
    assert.equal(FOLLOWER_INTERVAL_MS, 15 * 60 * 1000);
  } finally { db.close(); }
});

test('followers-only cannot accidentally process a single post', () => {
  assert.equal(parseLoopArguments(['--followers-only']).followersOnly, true);
  assert.throws(() => parseLoopArguments(['--followers-only', '--post', 'https://x.com/alice/status/1']));
});

function fakePage(store: any) {
  let user: any = null;
  globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'test-session', user: { email: 'test@example.com' } }), { status: 200 })) as any;
  (globalThis as any).__followerStore = store;
  return {
    url: () => 'chrome-extension://extension/index.html', goto: async () => {},
    waitForFunction: async () => {}, waitForTimeout: async () => {},
    locator: () => ({ innerText: async () => '' }),
    reload: async () => {},
    evaluate: async (fn: any, arg: any) => {
      if (arg === 'webUserInfo') return user;
      if (arg?.key === 'webUserInfo') { user = arg.value; return; }
      return fn(arg);
    },
  } as any;
}
function fakeStore(total: number, more = false) {
  const users = Array.from({ length: total }, (_, i) => ({ username: `u${i}`, uid: String(i + 1), subsCount: 100, followingCount: 100 }));
  return {
    task: { id: 'saved', type: 'followers', src: { username: 'alice' } },
    runningTaskId: null, isProcessing: false, fetchedCount: total, profileList: { hasMore: more },
    cooldownManager: { sleepForSearch: async () => {} },
    stopRun: async () => {},
    profileChunkStore: { queryPage: async ({ page, pageSize }) => users.slice((page - 1) * pageSize, page * pageSize) },
    toggleRun: async (): Promise<void> => { throw new Error('should use cached users'); },
  };
}
test('full page overflow is retained and consumed in the next batch without re-fetching', async () => {
  const store = fakeStore(225);
  const page = fakePage(store);
  const checkpoint = { taskId: 'saved', offset: 0, due: 0, done: false };
  let saved;
  try {
    const first = await readFollowerBatch(page, 'alice', checkpoint, id => { saved = id; }, () => {}, { historyLookup: async () => 'saved' });
    assert.equal(saved, 'saved');
    assert.equal(first.candidates.length, 200);
    assert.equal(first.nextOffset, 200);
    assert.equal(first.done, false);
    assert.equal(checkpoint.offset, 0, 'reading must not commit processing progress');
    const second = await readFollowerBatch(page, 'alice', { ...checkpoint, offset: first.nextOffset }, () => {}, () => {}, { historyLookup: async () => 'saved' });
    assert.equal(second.candidates.length, 25);
    assert.equal(second.candidates[0].userId, '201');
    assert.equal(second.done, true);
  } finally { delete (globalThis as any).__followerStore; }
});
test('a stopped incomplete export cannot advance the checkpoint', async () => {
  const store = fakeStore(80, true);
  store.toggleRun = async () => {};
  try {
    await assert.rejects(readFollowerBatch(fakePage(store), 'alice', { taskId: 'saved', offset: 0, due: 0, done: false }, () => {}, () => {}, { historyLookup: async () => 'saved' }), /未完成本批/);
  } finally { delete (globalThis as any).__followerStore; }
});
test('page boundary stops before requesting more data once 200 are collected', async () => {
  const store: any = fakeStore(0, true);
  let stopped = false;
  store.stopRun = async () => { stopped = true; store.runningTaskId = null; };
  store.toggleRun = async () => {
    store.runningTaskId = 'saved';
    store.fetchedCount = 200;
    await store.cooldownManager.sleepForSearch();
    store.profileChunkStore = fakeStore(200).profileChunkStore;
  };
  try {
    const result = await readFollowerBatch(fakePage(store), 'alice', { taskId: 'saved', offset: 0, due: 0, done: false }, () => {}, () => {}, { historyLookup: async () => 'saved' });
    assert.equal(stopped, true);
    assert.equal(result.candidates.length, 200);
    assert.equal(result.done, false);
  } finally { delete (globalThis as any).__followerStore; }
});

test('retries once when the exporter24 task page is slow to mount', async () => {
  const store = fakeStore(200);
  const page = fakePage(store);
  const originalWait = page.waitForFunction;
  let waits = 0;
  page.waitForFunction = async (...args: any[]) => {
    if (++waits === 1) throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
    return originalWait(...args);
  };
  try {
    const result = await readFollowerBatch(page, 'alice', { taskId: 'saved', offset: 0, due: 0, done: false }, () => {}, () => {}, { recoverTimeout: true, historyLookup: async () => 'saved' });
    assert.equal(result.candidates.length, 200);
    assert.ok(waits >= 2);
  } finally { delete (globalThis as any).__followerStore; }
});


test('selects latest history while preserving offset only for the same task', async () => {
  const checkpoint = { taskId: 'old', offset: 6200, due: 42, done: false };
  await selectFollowerHistory({} as any, 'alice', checkpoint, async () => 'old');
  assert.equal(checkpoint.offset, 6200);
  await selectFollowerHistory({} as any, 'alice', checkpoint, async () => 'new');
  assert.equal(checkpoint.taskId, 'new'); assert.equal(checkpoint.offset, 0);
  checkpoint.offset = 300;
  await selectFollowerHistory({} as any, 'alice', checkpoint, async () => null);
  assert.equal(checkpoint.taskId, null); assert.equal(checkpoint.offset, 0);
});

test('history lookup errors do not reset the saved checkpoint', async () => {
  const checkpoint = { taskId: 'old', offset: 6200, due: 42, done: false };
  await assert.rejects(selectFollowerHistory({} as any, 'alice', checkpoint, async () => { throw new Error('history unavailable'); }), FollowerHistoryError);
  assert.deepEqual(checkpoint, { taskId: 'old', offset: 6200, due: 42, done: false });
});

test('incomplete history is reset for a fresh task without committing the old offset', async () => {
  const checkpoint = { taskId: 'old', offset: 6200, due: 42, done: false };
  await selectFollowerHistory({} as any, 'alice', checkpoint, async () => { throw new Error('扩展粉丝历史记录不完整'); });
  assert.equal(checkpoint.taskId, null);
  assert.equal(checkpoint.offset, 0);
});

test('restarts from zero when an incomplete history task is safely stopped', async () => {
  const store = fakeStore(100);
  const page = fakePage(store);
  page.goto = async (url: string) => { if (url.includes('confirmed=1')) store.task.id = 'new'; };
  const checkpoint = { taskId: 'saved', offset: 200, due: 0, done: false };
  try {
    let saved = '';
    const result = await readFollowerBatch(page, 'alice', checkpoint, id => { saved = id; }, () => {}, { historyLookup: async () => 'saved' });
    assert.equal(saved, 'new');
    assert.equal(checkpoint.offset, 0);
    assert.equal(result.candidates.length, 100);
  } finally { delete (globalThis as any).__followerStore; }
});
