/** 持久化“镜像”监控配置：目标用户、发帖账号、水位线，以及每帖处理结果去重。 */
import { DatabaseSync } from "node:sqlite";

export type MirrorWatch = {
  targetUsername: string;
  targetId: string | null;
  posterId: string;
  sinceId: string | null;
  enabled: boolean;
};

export type MirrorPostStatus = "posted" | "skipped" | "failed";

export type MirrorPostRecord = {
  status: MirrorPostStatus;
  attempts: number;
};

export class MirrorStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS mirror_watches (
      target_username TEXT PRIMARY KEY,
      target_id TEXT,
      poster_id TEXT NOT NULL,
      since_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mirror_posts (
      target_id TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      poster_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('posted','skipped','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(target_id, tweet_id, poster_id)
    );`);
  }

  registerWatch({ targetUsername, targetId, posterId }: { targetUsername: string; targetId: string | null; posterId: string }) {
    this.db.prepare(`INSERT INTO mirror_watches (target_username, target_id, poster_id, since_id, enabled, updated_at) VALUES (?,?,?,NULL,1,?)
      ON CONFLICT(target_username) DO UPDATE SET target_id=excluded.target_id, poster_id=excluded.poster_id, updated_at=excluded.updated_at`)
      .run(targetUsername, targetId, posterId, new Date().toISOString());
  }

  getWatch(targetUsername: string): MirrorWatch | undefined {
    const row = this.db.prepare("SELECT * FROM mirror_watches WHERE target_username=? COLLATE NOCASE").get(targetUsername) as
      | { target_username: string; target_id: string | null; poster_id: string; since_id: string | null; enabled: number }
      | undefined;
    if (!row) return undefined;
    return { targetUsername: row.target_username, targetId: row.target_id, posterId: row.poster_id, sinceId: row.since_id, enabled: !!row.enabled };
  }

  listWatches(): MirrorWatch[] {
    return (this.db.prepare("SELECT * FROM mirror_watches ORDER BY target_username").all() as Array<{
      target_username: string; target_id: string | null; poster_id: string; since_id: string | null; enabled: number;
    }>).map((row) => ({ targetUsername: row.target_username, targetId: row.target_id, posterId: row.poster_id, sinceId: row.since_id, enabled: !!row.enabled }));
  }

  removeWatch(targetUsername: string) {
    this.db.prepare("DELETE FROM mirror_watches WHERE target_username=? COLLATE NOCASE").run(targetUsername);
  }

  setTargetId(targetUsername: string, targetId: string) {
    this.db.prepare("UPDATE mirror_watches SET target_id=?, updated_at=? WHERE target_username=? COLLATE NOCASE").run(targetId, new Date().toISOString(), targetUsername);
  }

  setSinceId(targetUsername: string, sinceId: string) {
    this.db.prepare("UPDATE mirror_watches SET since_id=?, updated_at=? WHERE target_username=? COLLATE NOCASE").run(sinceId, new Date().toISOString(), targetUsername);
  }

  postStatus(targetId: string, tweetId: string, posterId: string): MirrorPostRecord | undefined {
    const row = this.db.prepare("SELECT status, attempts FROM mirror_posts WHERE target_id=? AND tweet_id=? AND poster_id=?").get(targetId, tweetId, posterId) as
      | { status: MirrorPostStatus; attempts: number }
      | undefined;
    return row ? { status: row.status, attempts: row.attempts } : undefined;
  }

  /** 记录一次处理结果；failed 会累计尝试次数，其余状态重置为 0。 */
  recordPost(targetId: string, tweetId: string, posterId: string, status: MirrorPostStatus) {
    const now = new Date().toISOString();
    const attempts = status === "failed" ? (this.postStatus(targetId, tweetId, posterId)?.attempts ?? 0) + 1 : 0;
    this.db.prepare(`INSERT INTO mirror_posts (target_id, tweet_id, poster_id, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(target_id, tweet_id, poster_id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts, updated_at=excluded.updated_at`)
      .run(targetId, tweetId, posterId, status, attempts, now, now);
  }

  close() { this.db.close(); }
}
