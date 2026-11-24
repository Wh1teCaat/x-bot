import type { DatabaseSync } from 'node:sqlite';

type Run = { id: string; status: string; stage: string; state: string; pid: number | null };
/** 只合并确认尚未产出批次且没有关注操作的失败尝试。 */
export function planFollowerRecovery(db: DatabaseSync, account: string, blogger: string):
  { kind: 'none' } | { kind: 'blocked'; id: string } | { kind: 'resume'; id: string; supersede: string[] } {
  const rows = db.prepare("SELECT id,status,stage,state,pid FROM runs WHERE status NOT IN ('completed','superseded') ORDER BY updated_at DESC, rowid DESC").all() as Run[];
  const matches = rows.flatMap(row => {
    let state: any;
    try { state = JSON.parse(row.state); } catch { return []; }
    return state.followAccountId === account && state.blogger?.toLowerCase() === blogger.toLowerCase() && state.phase === 'followers' ? [{ row, state }] : [];
  });
  if (!matches.length) return { kind: 'none' };
  const unsafe = matches.find(({ row, state }) => row.status !== 'failed' || row.stage !== 'followers-export' || state.version !== 5 || !state.followerBatchMode || state.followerBatch || state.follow || state.followTargetIds && Object.keys(state.followTargetIds).length);
  if (unsafe) return { kind: 'blocked', id: unsafe.row.id };
  return { kind: 'resume', id: matches[0].row.id, supersede: matches.slice(1).map(item => item.row.id) };
}

/** 恢复成功后保留旧记录，标记为被同一断点的成功任务取代。 */
export function supersedeFollowerAttempts(db: DatabaseSync, ids: string[], recovered: string): void {
  const update = db.prepare("UPDATE runs SET status='superseded', error=? WHERE id=? AND status='failed' AND stage='followers-export'");
  db.exec('BEGIN IMMEDIATE');
  try { for (const id of ids) update.run(`已由任务 ${recovered} 从共享粉丝断点恢复`, id); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
