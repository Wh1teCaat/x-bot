import type { DatabaseSync } from 'node:sqlite';

/** exporter 故障与 X 熔断分开记录；等待期与次数跨进程、重启保留。 */
export class ExporterRetry {
  private db: DatabaseSync;
  private scope: string;
  private now: () => number;
  private random: () => number;
  constructor(db: DatabaseSync, scope: string, now = Date.now, random = Math.random) {
    this.db = db; this.scope = scope; this.now = now; this.random = random;
    db.exec(`CREATE TABLE IF NOT EXISTS exporter_retry (
      scope TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, state TEXT NOT NULL
    )`);
  }
  get() { return this.db.prepare('SELECT attempts,next_at,state FROM exporter_retry WHERE scope=?').get(this.scope) as { attempts: number; next_at: number; state: string } | undefined; }
  success() { this.db.prepare('DELETE FROM exporter_retry WHERE scope=?').run(this.scope); }
  stop() { this.db.prepare("INSERT INTO exporter_retry VALUES(?,0,0,'manual') ON CONFLICT(scope) DO UPDATE SET next_at=0,state='manual'").run(this.scope); }
  fail() {
    const prior = this.get();
    const attempts = (prior?.attempts || 0) + 1;
    const state = attempts >= 4 ? 'manual' : 'waiting';
    const base = Math.min(15 * 60_000, 5 * 60_000 * attempts);
    const next = state === 'manual' ? 0 : this.now() + base + Math.floor(this.random() * base * 0.1);
    this.db.prepare('INSERT INTO exporter_retry VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,state=excluded.state').run(this.scope, attempts, next, state);
    return { attempts, next, state };
  }
  async run<T>(fn: () => Promise<T>, options: { guard: () => void | Promise<void>; safeToRetry?: () => Promise<boolean>; sleep?: (ms: number) => Promise<void> }): Promise<T> {
    const sleep = options.sleep || (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (;;) {
      const current = this.get();
      if (current?.state === 'manual') throw new ExporterError(current.attempts >= 4 ? 'exporter24 重试次数已耗尽，需要人工检查' : 'exporter24 上次遇到登录、额度或任务状态异常，仍处于人工检查状态', false);
      while (current && current.next_at > this.now()) {
        await options.guard();
        await sleep(Math.min(30_000, current.next_at - this.now()));
      }
      await options.guard();
      try {
        const result = await fn();
        this.success();
        return result;
      } catch (error) {
        // X 的 guard 优先，绝不能把 X 熔断包装为 exporter 故障。
        await options.guard();
        if (!isRetryableExporterError(error)) { console.error(`exporter24 原始错误：${error instanceof Error ? error.message : String(error)}`); this.stop(); throw new ExporterError('exporter24 需要人工检查登录、额度或任务状态', false, error); }
        if (options.safeToRetry && !await options.safeToRetry()) { this.stop(); throw new ExporterError('无法确认 exporter24 任务已停止，请人工检查后恢复', false, error); }
        const next = this.fail();
        if (next.state === 'manual') throw new ExporterError('exporter24 重试次数已耗尽，需要人工检查', false, error);
        console.log(`exporter24 暂时不可用，第 ${next.attempts} 次退避至 ${new Date(next.next).toLocaleString('zh-CN', { hour12: false })}。`);
      }
    }
  }
}

export class ExporterError extends Error {
  readonly source = 'exporter';
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean, cause?: unknown) { super(message, { cause }); this.retryable = retryable; }
}

/** 登录接口的网络错误与身份、额度等需要人工处理的错误分开。 */
export class ExporterTransientError extends Error {
  readonly status?: number;
  constructor(message: string, cause?: unknown, status?: number) { super(message, { cause }); this.name = 'ExporterTransientError'; this.status = status; }
}

/** 只对可识别的限流和暂时错误重试，登录、认证、额度及身份异常交人工检查。 */
export function isRetryableExporterError(error: any): boolean {
  if (error instanceof ExporterTransientError) return true;
  const message = String(error?.message || '');
  if (/登录|login|sign.?in|额度|quota|credit|captcha|验证|权限|unauthori[sz]ed|forbidden|身份不匹配|版本不支持/i.test(message)) return false;
  return error?.status === 429 || error?.status >= 500 || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code) || /429|rate.?limit|too many|try again|限流|速率受限|超时|timeout|timed out|未完成本批|未返回关注\/粉丝数/i.test(message);
}
