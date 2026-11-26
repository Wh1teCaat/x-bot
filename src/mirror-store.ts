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

const watchSchema = `CREATE TABLE IF NOT EXISTS mirror_watches (
  poster_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_username TEXT NOT NULL COLLATE NOCASE,
  target_id TEXT,
  since_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(poster_id, target_key)
)`;

export class MirrorStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec(`${watchSchema};
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
      owner_pid INTEGER,
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
    this.migrate();
  }

  private migrate() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(mirror_watches)').all();
      if (!columns.some(column => column.name === 'target_key')) {
        this.db.exec(`
          ALTER TABLE mirror_watches RENAME TO mirror_watches_legacy;
          ${watchSchema};
          INSERT OR IGNORE INTO mirror_watches
            SELECT poster_id, COALESCE(target_id, '@'||lower(target_username)),
              target_username, target_id, since_id, enabled, updated_at
            FROM mirror_watches_legacy ORDER BY updated_at DESC, rowid DESC;
          DROP TABLE mirror_watches_legacy;
        `);
      }
      const jobColumns = this.db.prepare('PRAGMA table_info(mirror_reply_jobs)').all();
      if (!jobColumns.some(column => column.name === 'owner_pid'))
        this.db.exec('ALTER TABLE mirror_reply_jobs ADD COLUMN owner_pid INTEGER');
      this.db.exec(`CREATE INDEX IF NOT EXISTS mirror_reply_due
        ON mirror_reply_jobs(poster_id, due_at) WHERE status IN ('pending','failed') AND attempts<3`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  registerWatch({ targetUsername, targetId, posterId }: { targetUsername: string; targetId: string | null; posterId: string }) {
    const handleKey = '@' + targetUsername.toLowerCase();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const known = targetId === null
        ? this.db.prepare('SELECT target_id FROM mirror_watches WHERE poster_id=? AND target_username=? AND target_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(posterId, targetUsername)
        : undefined;
      const id = targetId ?? (known?.target_id as string | undefined) ?? null;
      const key = id ?? handleKey;
      this.db.prepare(`INSERT INTO mirror_watches (poster_id,target_key,target_username,target_id,since_id,enabled,updated_at)
        VALUES (?,?,?,?,(SELECT since_id FROM mirror_watches WHERE poster_id=? AND target_key=?),
          COALESCE((SELECT enabled FROM mirror_watches WHERE poster_id=? AND target_key=?),1),?)
        ON CONFLICT(poster_id,target_key) DO UPDATE SET target_username=excluded.target_username, updated_at=excluded.updated_at`)
        .run(posterId, key, targetUsername, id, posterId, handleKey, posterId, handleKey, now);
      if (key !== handleKey) this.db.prepare('DELETE FROM mirror_watches WHERE poster_id=? AND target_key=?').run(posterId, handleKey);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getWatch(posterId: string, targetId: string): MirrorWatch | undefined {
    const row = this.db.prepare("SELECT * FROM mirror_watches WHERE poster_id=? AND target_key=?")
      .get(posterId, targetId) as
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

  setSinceId(posterId: string, targetId: string, sinceId: string) {
    this.db.prepare(`UPDATE mirror_watches SET since_id=?, updated_at=?
      WHERE poster_id=? AND target_key=?
      AND (since_id IS NULL OR length(since_id)<length(?) OR (length(since_id)=length(?) AND since_id<?))`)
      .run(sinceId, new Date().toISOString(), posterId, targetId, sinceId, sinceId, sinceId);
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
  dueReplyJobs(now = Date.now(), limit = 1, posterId?: string): MirrorReplyJob[] {
    const accountFilter = posterId === undefined ? '' : 'AND poster_id=?';
    return (this.db.prepare(`SELECT * FROM mirror_reply_jobs
      WHERE status IN ('pending','failed') AND due_at<=? AND attempts<3 ${accountFilter}
      ORDER BY due_at LIMIT ?`).all(now, ...(posterId === undefined ? [] : [posterId]), limit) as any[]).map((row) => ({
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
  claimReplyJob(job: MirrorReplyJob, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE mirror_reply_jobs
      SET status='running', attempts=attempts+1, owner_pid=?, updated_at=?
      WHERE target_id=? AND tweet_id=? AND poster_id=? AND status IN ('pending','failed')
        AND due_at<=? AND due_at=? AND attempts=? AND attempts<3`)
      .run(process.pid, new Date(now).toISOString(), job.targetId, job.tweetId, job.posterId, now, job.dueAt, job.attempts);
    return result.changes > 0;
  }

  /** 记录回复任务结果；失败时写入下一次重试时间。 */
  finishReplyJob(job: MirrorReplyJob, status: 'done' | 'failed', error: string | null, nextDueAt?: number): boolean {
    return !!this.db.prepare(`UPDATE mirror_reply_jobs
      SET status=?, last_error=?, due_at=COALESCE(?, due_at), updated_at=?, owner_pid=NULL
      WHERE target_id=? AND tweet_id=? AND poster_id=? AND status='running' AND attempts=? AND owner_pid=?`)
      .run(status, error, nextDueAt ?? null, new Date().toISOString(), job.targetId, job.tweetId, job.posterId, job.attempts + 1, process.pid).changes;
  }

  /** 将长时间处于 running 的任务重新放回队列，避免进程崩溃后永久卡住。 */
  recoverStaleReplyJobs(staleBeforeIso: string, dueAt = Date.now(), posterId?: string) {
    const rows = this.db.prepare(`SELECT target_id,tweet_id,poster_id,attempts,owner_pid,updated_at FROM mirror_reply_jobs
      WHERE status='running' AND (owner_pid IS NOT NULL OR updated_at<?) AND poster_id=COALESCE(?, poster_id)`)
      .all(staleBeforeIso, posterId ?? null) as Array<{ target_id: string; tweet_id: string; poster_id: string; attempts: number; owner_pid: number | null; updated_at: string }>;
    const recover = this.db.prepare(`UPDATE mirror_reply_jobs SET status='failed', due_at=?,
      last_error='任务进程中断', updated_at=?, owner_pid=NULL
      WHERE target_id=? AND tweet_id=? AND poster_id=? AND status='running' AND attempts=? AND owner_pid IS ? AND updated_at=?`);
    for (const row of rows) {
      if (row.owner_pid !== null) {
        try { process.kill(row.owner_pid, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      recover.run(dueAt, new Date(dueAt).toISOString(), row.target_id, row.tweet_id, row.poster_id, row.attempts, row.owner_pid, row.updated_at);
    }
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
