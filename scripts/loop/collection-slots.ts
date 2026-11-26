import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { acquireBrowserSlot, type BrowserSlotRelease } from '../browser/browser-slots.ts';
import type { LoopArguments } from './loop-arguments.ts';

/** 等待全局帖子或粉丝采集许可，组合任务按固定顺序同时持有两种许可。 */
export async function acquireCollectionSlots(
  args: LoopArguments,
  onWait: (lane: string) => void,
  cancelled?: () => boolean,
  dataDir = resolve('.data'),
): Promise<() => void> {
  const state = args.resumeId ? savedState(dataDir, args.resumeId) : {};
  const lanes = args.followersOnly || state.phase === 'followers' ? ['followers']
    : args.noFollowers || args.postUrl || state.singlePost ? ['posts'] : ['posts', 'followers'];
  const releases: BrowserSlotRelease[] = [];
  const release = () => { while (releases.length) releases.pop()!(); };
  try {
    for (const lane of lanes) {
      releases.push(await acquireBrowserSlot(args.accountId ?? 'shared', {
        path: resolve(dataDir, `collection-${lane}-slots.sqlite`),
        limit: 1,
        onWait: () => onWait(lane === 'posts' ? '帖子' : '粉丝'),
        cancelled,
      }));
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function savedState(dataDir: string, runId: string): { phase?: string; singlePost?: boolean } {
  const path = resolve(dataDir, 'loop.sqlite');
  if (!existsSync(path)) throw new Error('未找到要恢复的任务');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const row = db.prepare('SELECT state FROM runs WHERE id=?').get(runId);
    if (!row) throw new Error('未找到要恢复的任务');
    return JSON.parse(String(row.state));
  } finally {
    db.close();
  }
}
