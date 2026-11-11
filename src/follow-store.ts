/** 保存按授权账号隔离的关注状态和同步记录。 */
import { DatabaseSync } from "node:sqlite";

/** 保存关注状态并防止同一账号重复预留目标。 */
export class FollowStore {
  private db: DatabaseSync;

  /** 打开数据库并初始化关注与同步表。 */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS follows (
      account_id TEXT NOT NULL, target_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('following', 'pending', 'uncertain')),
      updated_at TEXT NOT NULL, PRIMARY KEY(account_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS follow_sync (
      account_id TEXT PRIMARY KEY, synced_at TEXT NOT NULL, user_count INTEGER NOT NULL
    );`);
  }

  /** 读取指定账号对目标的已知关注状态。 */
  status(accountId: string, targetId: string): string | undefined {
    return (this.db.prepare("SELECT status FROM follows WHERE account_id = ? AND target_id = ?").get(accountId, targetId) as { status: string } | undefined)?.status;
  }

  /** 原子预留尚未处理的目标，表示请求结果待确认。 */
  reserve(accountId: string, targetId: string): boolean {
    return !!this.db.prepare("INSERT OR IGNORE INTO follows VALUES (?, ?, 'uncertain', ?)").run(accountId, targetId, new Date().toISOString()).changes;
  }

  /** 仅清除指定目标仍未确认的预留记录。 */
  clearUncertain(accountId: string, targetId: string) {
    this.db.prepare("DELETE FROM follows WHERE account_id=? AND target_id=? AND status='uncertain'").run(accountId, targetId);
  }

  /** 持久化关注、待批准或未确认状态。 */
  record(accountId: string, targetId: string, status: "following" | "pending" | "uncertain") {
    this.db.prepare(`INSERT INTO follows VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, target_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
      .run(accountId, targetId, status, new Date().toISOString());
  }

  /** 在事务中替换已关注列表，同时保留待批准和未确认记录。 */
  replaceFollowing(accountId: string, ids: Set<string>) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM follows WHERE account_id = ? AND status = 'following'").run(accountId);
      const insert = this.db.prepare(`INSERT INTO follows VALUES (?, ?, 'following', ?)
        ON CONFLICT(account_id, target_id) DO UPDATE SET status = 'following', updated_at = excluded.updated_at`);
      for (const id of ids) insert.run(accountId, id, now);
      this.db.prepare(`INSERT INTO follow_sync VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET synced_at = excluded.synced_at, user_count = excluded.user_count`)
        .run(accountId, now, ids.size);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 关闭关注状态数据库。 */
  close() { this.db.close(); }
}

type Page = { data?: { id: string }[]; errors?: unknown[]; meta?: { next_token?: string; result_count?: number } };

/** 分页读取完整关注列表，结果完整时才更新本地缓存。 */
export async function syncFollowing(store: FollowStore, accountId: string, fetchPage: (token?: string) => Promise<Page>) {
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await fetchPage(token);
    if (!result || result.errors?.length || !result.meta ||
        (result.data !== undefined && !Array.isArray(result.data)) ||
        (!result.data && result.meta.result_count !== 0))
      throw new Error("已关注列表响应不完整，未更新缓存。");
    for (const user of result.data || []) {
      if (!user || typeof user.id !== "string" || !/^\d{1,19}$/.test(user.id))
        throw new Error("已关注列表包含无效用户 ID，未更新缓存。");
      ids.add(user.id);
    }
    const next = result.meta.next_token;
    if (next === undefined) {
      store.replaceFollowing(accountId, ids);
      return { pages: page + 1, count: ids.size };
    }
    if (typeof next !== "string" || !next || tokens.has(next))
      throw new Error("已关注列表分页无效，未更新缓存。");
    tokens.add(next);
    token = next;
  }
  throw new Error("已关注列表超过 100 页上限，未更新缓存。");
}
