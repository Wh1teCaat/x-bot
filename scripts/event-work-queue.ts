/** 实现可由持久化存储驱动的单进程事件队列。 */
// Event-driven single-process runner. The caller supplies persistent storage and
// a handler, so a later message-queue consumer can use the same contract.
type WorkStore<Job> = {
  enqueue: (job: Job) => Promise<unknown>;
  claimReady: (now: number) => Promise<Job | null>;
  complete: (job: Job) => Promise<void>;
  fail: (job: Job, error: unknown, now: number) => Promise<void>;
  nextDue: () => Promise<number | null>;
};
export type TimerHandle = number | NodeJS.Timeout;
export type SetTimer = (callback: () => void, delay: number) => TimerHandle;
export type ClearTimer = (handle: TimerHandle) => void;
/** 事件驱动地领取就绪任务，空闲时仅为延迟任务设置定时器。 */
export class EventWorkQueue<Job> {
  store: WorkStore<Job>;
  handle: (job: Job) => Promise<unknown>;
  onError: (error: unknown) => void;
  now: () => number;
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  running: boolean;
  closed: boolean;
  scheduled: boolean;
  timer: TimerHandle | null;
  wakePending: boolean;
  /** 注入任务存储、处理函数和可测试的时钟。 */
  constructor({ store, handle, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }: {
    store: WorkStore<Job>; handle: (job: Job) => Promise<unknown>; onError?: (error: unknown) => void;
    now?: () => number; setTimer?: SetTimer; clearTimer?: ClearTimer;
  }) {
    this.store = store; this.handle = handle; this.onError = onError;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.running = false; this.closed = false; this.scheduled = false; this.timer = null; this.wakePending = false;
  }
  /** 启动队列并检查现有就绪任务。 */
  start() { this.wake(); }
  /** 持久化新任务并立即唤醒消费者。 */
  async enqueue(job: Job) {
    if (this.closed) throw new Error('队列已关闭');
    await this.store.enqueue(job);
    this.wake();
  }
  /** 合并并发唤醒，确保活动任务结束后不会遗漏新任务。 */
  wake() {
    if (this.closed) return;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.running) { this.wakePending = true; return; }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain().catch(this.onError); });
  }
  /** 串行领取任务并将处理结果写回存储。 */
  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed) {
        const job = await this.store.claimReady(this.now());
        if (!job) break;
        try { await this.handle(job); await this.store.complete(job); }
        catch (error) { await this.store.fail(job, error, this.now()); }
      }
    } finally {
      this.running = false;
      if (!this.closed) {
        const next = await this.store.nextDue();
        if (this.wakePending) { this.wakePending = false; this.wake(); }
        else if (next != null) this.timer = this.setTimer(() => { this.timer = null; this.wake(); }, Math.max(0, next - this.now()));
      }
    }
  }
  /** 停止后续领取并取消等待中的定时器。 */
  close() { this.closed = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
}
