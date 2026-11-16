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

export type MirrorReplyJob = {
  targetId: string;
  tweetId: string;
  posterId: string;
  targetUsername: string;
  postUrl: string;
  dueAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
};

export class MirrorStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS mirror_watches (
      target_username TEXT PRIMARY KEY,
      target_id TEXT,
      poster_id TEXT NOT NULL,
      since_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mirror_reply_jobs (
      target_id TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      poster_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      post_url TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(target_id, tweet_id, poster_id)
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

  /** 新帖镜像成功后，登记一次延迟回复爬取任务；同一帖只登记一次。 */
  enqueueReplyJob({ targetId, tweetId, posterId, targetUsername, postUrl, dueAt }: {
    targetId: string; tweetId: string; posterId: string; targetUsername: string; postUrl: string; dueAt: number;
  }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO mirror_reply_jobs
      (target_id, tweet_id, poster_id, target_username, post_url, due_at, status, attempts, last_error, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'pending', 0, NULL, ?, ?)`)
      .run(targetId, tweetId, posterId, targetUsername, postUrl, dueAt, now, now);
  }

  /** 读取到期且未超过重试上限的回复任务。 */
  dueReplyJobs(now = Date.now(), limit = 1): MirrorReplyJob[] {
    return (this.db.prepare(`SELECT * FROM mirror_reply_jobs
      WHERE status IN ('pending','failed') AND due_at<=? AND attempts<3
      ORDER BY due_at LIMIT ?`).all(now, limit) as any[]).map((row) => ({
        targetId: row.target_id,
        tweetId: row.tweet_id,
        posterId: row.poster_id,
        targetUsername: row.target_username,
        postUrl: row.post_url,
        dueAt: row.due_at,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
      }));
  }

  /** 原子领取一个到期任务；已被其他进程领取时返回 false。 */
  claimReplyJob(job: Pick<MirrorReplyJob, 'targetId' | 'tweetId' | 'posterId'>): boolean {
    const result = this.db.prepare(`UPDATE mirror_reply_jobs
      SET status='running', attempts=attempts+1, updated_at=?
      WHERE target_id=? AND tweet_id=? AND poster_id=? AND status IN ('pending','failed') AND attempts<3`)
      .run(new Date().toISOString(), job.targetId, job.tweetId, job.posterId);
    return result.changes > 0;
  }

  /** 记录回复任务结果；失败时写入下一次重试时间。 */
  finishReplyJob(job: Pick<MirrorReplyJob, 'targetId' | 'tweetId' | 'posterId'>, status: 'done' | 'failed', error: string | null, nextDueAt?: number) {
    this.db.prepare(`UPDATE mirror_reply_jobs
      SET status=?, last_error=?, due_at=COALESCE(?, due_at), updated_at=?
      WHERE target_id=? AND tweet_id=? AND poster_id=?`)
      .run(status, error, nextDueAt ?? null, new Date().toISOString(), job.targetId, job.tweetId, job.posterId);
  }

  /** 将长时间处于 running 的任务重新放回队列，避免进程崩溃后永久卡住。 */
  recoverStaleReplyJobs(staleBeforeIso: string, dueAt = Date.now()) {
    this.db.prepare(`UPDATE mirror_reply_jobs
      SET status='failed', due_at=?, last_error='任务进程中断', updated_at=?
      WHERE status='running' AND updated_at<? AND attempts<3`)
      .run(dueAt, new Date().toISOString(), staleBeforeIso);
  }

  listReplyJobs(): MirrorReplyJob[] {
    return (this.db.prepare('SELECT * FROM mirror_reply_jobs ORDER BY due_at').all() as any[]).map((row) => ({
      targetId: row.target_id, tweetId: row.tweet_id, posterId: row.poster_id,
      targetUsername: row.target_username, postUrl: row.post_url, dueAt: row.due_at,
      status: row.status, attempts: row.attempts, lastError: row.last_error,
    }));
  }

  close() { this.db.close(); }
}
