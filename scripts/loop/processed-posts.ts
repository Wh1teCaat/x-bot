import type { DatabaseSync } from 'node:sqlite';

/** 处理历史按授权账号和帖子 ID 隔离，链接域名或用户名变化不影响去重。 */
export function postId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) return null;
    return /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,19})\/?$/.exec(parsed.pathname)?.[1] ?? null;
  } catch { return null; }
}

export class ProcessedPosts {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS processed_posts (account_id TEXT NOT NULL, post_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(account_id, post_id))');
  }
  has(account: string | undefined, url: unknown): boolean {
    const id = postId(url);
    return Boolean(account && id && this.db.prepare('SELECT 1 FROM processed_posts WHERE account_id=? AND post_id=?').get(account, id));
  }
  mark(account: string | undefined, url: unknown, runId: string): void {
    const id = postId(url);
    if (account && id) this.db.prepare('INSERT OR IGNORE INTO processed_posts VALUES (?,?,?)').run(account, id, runId);
  }
  /** 从旧任务的已保存结果补齐历史；跳过不完整、跳过关注和无法确认归属的记录。 */
  importHistory(account: string | undefined): void {
    if (!account) return;
    for (const row of this.db.prepare('SELECT id,state FROM runs').all() as Array<{ id: string; state: string }>) {
      let state: any;
      try { state = JSON.parse(row.state); } catch { continue; }
      if (state.followAccountId !== account || !Array.isArray(state.results)) continue;
      for (const result of state.results) {
        if (result?.phase !== 'replies' || !result.export || !result.qualify || result.followSkipped || !Array.isArray(result.follow?.unresolved) || result.follow.unresolved.length) continue;
        this.mark(account, result.post?.url, row.id);
      }
    }
  }
}
