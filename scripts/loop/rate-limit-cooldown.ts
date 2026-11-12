/** 持久化冷却期限并在到期后执行受控恢复探测。 */
// The probe must return true only when it has verified recovery; errors or
// inconclusive responses keep the circuit open and start a fresh cooldown.
import type { DatabaseSync } from 'node:sqlite';
import type { TimerHandle, SetTimer, ClearTimer } from './event-work-queue.ts';
type CooldownStore = { setNext(at: number): Promise<void>; getNext(): Promise<number | null>; clear(): Promise<void> };

/** 将指定服务的下次探测时间保存在 SQLite。 */
export class SqliteCooldownStore {
  db: DatabaseSync;
  scope: string;
  /** 初始化指定服务的持久化冷却记录。 */
  constructor(db: DatabaseSync, scope: string) {
    this.db = db; this.scope = scope;
    db.exec('CREATE TABLE IF NOT EXISTS cooldowns (scope TEXT PRIMARY KEY, next_at INTEGER NOT NULL)');
  }
  /** 持久化下一次允许探测的时间。 */
  async setNext(at: number) { this.db.prepare('INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET next_at=excluded.next_at').run(this.scope, at); }
  /** 读取已保存的探测时间，未限流时返回空值。 */
  async getNext(): Promise<number | null> { return (this.db.prepare('SELECT next_at FROM cooldowns WHERE scope=?').get(this.scope) as { next_at: number } | undefined)?.next_at ?? null; }
  /** 清除当前服务的冷却记录。 */
  async clear() { this.db.prepare('DELETE FROM cooldowns WHERE scope=?').run(this.scope); }
}

/** 管理限流冷却、半开探测和失败后的重新计时。 */
export class RateLimitCooldown {
  store: CooldownStore;
  probe: () => Promise<boolean>;
  onRecovered: () => void | Promise<void>;
  now: () => number;
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  intervalMs: number;
  timer: TimerHandle | null;
  closed: boolean;
  checking: boolean;
  generation: number;
  /** 注入存储、探测函数和可替换时钟。 */
  constructor({ store, probe, onRecovered = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 15 * 60 * 1000 }: {
    store: CooldownStore; probe: () => Promise<boolean>; onRecovered?: () => void | Promise<void>;
    now?: () => number; setTimer?: SetTimer; clearTimer?: ClearTimer; intervalMs?: number;
  }) {
    Object.assign(this, { store, probe, onRecovered, now, setTimer, clearTimer, intervalMs });
    this.timer = null; this.closed = false; this.checking = false; this.generation = 0;
  }
  /** 记录一次限流并从当前时间重新计算冷却期限。 */
  async limited() {
    this.generation++;
    await this.store.setNext(this.now() + this.intervalMs);
    await this.start();
  }
  /** 根据持久化期限恢复定时探测。 */
  async start() {
    if (this.closed) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const next = await this.store.getNext();
    if (next != null && !this.closed) this.timer = this.setTimer(() => { this.timer = null; this.check().catch(() => {}); }, Math.max(0, next - this.now()));
  }
  /** 执行一次探测，仅在确认恢复后调用恢复处理。 */
  async check() {
    if (this.closed || this.checking) return;
    this.checking = true;
    const generation = this.generation;
    try {
      let recovered = false;
      try { recovered = (await this.probe()) === true; } catch {}
      if (this.closed || generation !== this.generation) return;
      if (recovered) { await this.store.clear(); await this.onRecovered(); }
      else { await this.store.setNext(this.now() + this.intervalMs); await this.start(); }
    } finally { this.checking = false; }
  }
  /** 停止冷却任务并清除本进程的定时器。 */
  close() { this.closed = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
}
