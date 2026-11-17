import { DatabaseSync } from 'node:sqlite';

export type OutboxItem = { account_id: string; target_id: string; username: string; source: string; status: string };

/** 持久队列按账号和 X 数字 ID 去重。处理中断的条目不自动重发。 */
export class FollowOutbox {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS follow_outbox (
        account_id TEXT NOT NULL, target_id TEXT NOT NULL, username TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', updated_at INTEGER NOT NULL, error TEXT,
        PRIMARY KEY(account_id, target_id)
      );
      CREATE TABLE IF NOT EXISTS follow_outbox_sources (
        account_id TEXT NOT NULL, target_id TEXT NOT NULL, source TEXT NOT NULL,
        PRIMARY KEY(account_id, target_id, source)
      );
      CREATE TABLE IF NOT EXISTS follow_outbox_schedule (account_id TEXT PRIMARY KEY, next_batch_at INTEGER NOT NULL);`);
  }
  enqueue(account: string, rows: Array<{ id: string; username: string; source: string }>) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO follow_outbox VALUES (?, ?, ?, ?, 'queued', ?, NULL)");
    const source = this.db.prepare('INSERT OR IGNORE INTO follow_outbox_sources VALUES (?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try { let added = 0; for (const row of rows) { added += Number(insert.run(account, row.id, row.username, row.source, Date.now()).changes); source.run(account, row.id, row.source); } this.db.exec('COMMIT'); return added; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  pending(account: string): OutboxItem[] { return this.db.prepare("SELECT * FROM follow_outbox WHERE account_id=? AND status='queued' ORDER BY updated_at,target_id LIMIT 20").all(account) as OutboxItem[]; }
  begin(account: string, target: string) { return !!this.db.prepare("UPDATE follow_outbox SET status='processing',updated_at=? WHERE account_id=? AND target_id=? AND status='queued'").run(Date.now(), account, target).changes; }
  finish(account: string, target: string, status: 'done' | 'manual' | 'queued', error: string | null = null) { this.db.prepare("UPDATE follow_outbox SET status=?,error=?,updated_at=? WHERE account_id=? AND target_id=? AND status='processing'").run(status, error, Date.now(), account, target); }
  recover(account: string) { this.db.prepare("UPDATE follow_outbox SET status='manual',error='进程中断，关注结果需核实',updated_at=? WHERE account_id=? AND status='processing'").run(Date.now(), account); }
  nextBatch(account: string): number { return (this.db.prepare('SELECT next_batch_at FROM follow_outbox_schedule WHERE account_id=?').get(account) as { next_batch_at: number } | undefined)?.next_batch_at || 0; }
  schedule(account: string, time: number) { this.db.prepare('INSERT INTO follow_outbox_schedule VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET next_batch_at=excluded.next_batch_at').run(account, time); }
  close() { this.db.close(); }
}
