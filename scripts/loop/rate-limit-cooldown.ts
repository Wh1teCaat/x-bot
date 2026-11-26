/** 持久化冷却期限并在到期后执行受控恢复探测。 */
// The probe must return true only when it has verified recovery; errors or
// inconclusive responses keep the circuit open and start a fresh cooldown.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { TimerHandle, SetTimer, ClearTimer } from './event-work-queue.ts';
export const X_COOLDOWN_MS = 15 * 60 * 1000;
const PROBE_LEASE_MS = 5 * 60 * 1000;
const PROBE_OBSERVER_MS = 2000;

/** 将指定服务的下次探测时间保存在 SQLite。 */
export class SqliteCooldownStore {
  db: DatabaseSync;
  scope: string;
  /** 初始化指定服务的持久化冷却记录。 */
  constructor(db: DatabaseSync, scope: string) {
    this.db = db; this.scope = scope;
    db.exec(`CREATE TABLE IF NOT EXISTS cooldowns (scope TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldown_probes (
        scope TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until INTEGER NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0
      )`);
  }
  /** 持久化下一次允许探测的时间。 */
  async setNext(at: number) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET next_at=MAX(next_at, excluded.next_at)').run(this.scope, at);
      this.db.prepare('UPDATE cooldown_probes SET invalidated=1 WHERE scope=?').run(this.scope);
    });
  }
  /** 读取已保存的探测时间，未限流时返回空值。 */
  async getNext(): Promise<number | null> { return (this.db.prepare('SELECT next_at FROM cooldowns WHERE scope=?').get(this.scope) as { next_at: number } | undefined)?.next_at ?? null; }
  /** 清除当前服务的冷却记录。 */
  async clear() {
    this.transaction(() => {
      this.db.prepare('DELETE FROM cooldowns WHERE scope=?').run(this.scope);
      this.db.prepare('DELETE FROM cooldown_probes WHERE scope=?').run(this.scope);
    });
  }

  claim(now: number): string | null {
    const token = randomUUID();
    const claimed = this.db.prepare(`INSERT INTO cooldown_probes(scope,token,lease_until)
      SELECT scope,?,? FROM cooldowns WHERE scope=? AND next_at<=?
      ON CONFLICT(scope) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until,invalidated=0
      WHERE cooldown_probes.lease_until<=?`).run(token, now + PROBE_LEASE_MS, this.scope, now, now);
    return claimed.changes ? token : null;
  }

  /** 只有仍持有探测资格的进程可以清除或推迟当前冷却。 */
  settle(token: string, now: number, retryAt: number, recovered: boolean, confirmRecovery: () => boolean): boolean {
    return this.transaction(() => {
      const claim = this.db.prepare('SELECT lease_until,invalidated FROM cooldown_probes WHERE scope=? AND token=?')
        .get(this.scope, token);
      if (!claim) return false;
      this.db.prepare('DELETE FROM cooldown_probes WHERE scope=? AND token=?').run(this.scope, token);
      if (claim.invalidated || Number(claim.lease_until) <= now) return false;
      const confirmed = recovered && confirmRecovery();
      if (confirmed) this.db.prepare('DELETE FROM cooldowns WHERE scope=?').run(this.scope);
      else this.db.prepare('UPDATE cooldowns SET next_at=MAX(next_at, ?) WHERE scope=?').run(retryAt, this.scope);
      return confirmed;
    });
  }

  release(token: string) {
    this.db.prepare('DELETE FROM cooldown_probes WHERE scope=? AND token=?').run(this.scope, token);
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** 管理限流冷却、半开探测和失败后的重新计时。 */
export class RateLimitCooldown {
  store: SqliteCooldownStore;
  probe: () => Promise<boolean>;
  onRecovered: () => void | Promise<void>;
  confirmRecovery: () => boolean;
  onError: (error: unknown) => void;
  now: () => number;
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  intervalMs: number;
  timer: TimerHandle | null;
  closed: boolean;
  checking: boolean;
  claimToken: string | null = null;
  /** 注入存储、探测函数和可替换时钟。 */
  constructor({ store, probe, onRecovered = () => {}, confirmRecovery = () => true, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = X_COOLDOWN_MS }: {
    store: SqliteCooldownStore; probe: () => Promise<boolean>; onRecovered?: () => void | Promise<void>;
    confirmRecovery?: () => boolean; onError?: (error: unknown) => void;
    now?: () => number; setTimer?: SetTimer; clearTimer?: ClearTimer; intervalMs?: number;
  }) {
    Object.assign(this, { store, probe, onRecovered, confirmRecovery, onError, now, setTimer, clearTimer, intervalMs });
    this.timer = null; this.closed = false; this.checking = false;
  }
  /** 记录一次限流并从当前时间重新计算冷却期限。 */
  async limited() {
    await this.store.setNext(this.now() + this.intervalMs);
    await this.start();
  }
  /** 根据持久化期限恢复定时探测。 */
  async start() {
    if (this.closed) return;
    const next = await this.store.getNext();
    if (this.closed) return;
    if (next == null) await this.onRecovered();
    else this.schedule(Math.max(0, next - this.now()));
  }

  private schedule(delay: number) {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.check().catch(this.onError); }, delay);
  }
  /** 执行一次探测，仅在确认恢复后调用恢复处理。 */
  async check() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      const next = await this.store.getNext();
      if (this.closed) return;
      if (next == null) { await this.onRecovered(); return; }
      if (next > this.now()) { this.schedule(next - this.now()); return; }
      const token = this.store.claim(this.now());
      if (!token) { this.schedule(PROBE_OBSERVER_MS); return; }
      this.claimToken = token;
      let recovered = false;
      try { recovered = (await this.probe()) === true; } catch {}
      if (this.closed) return;
      const now = this.now();
      const confirmed = this.store.settle(token, now, now + this.intervalMs, recovered, this.confirmRecovery);
      this.claimToken = null;
      if (confirmed) await this.onRecovered();
      else await this.start();
    } finally { this.checking = false; }
  }
  /** 停止冷却任务并清除本进程的定时器。 */
  close() {
    this.closed = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.claimToken) this.store.release(this.claimToken);
    this.claimToken = null;
  }
}
