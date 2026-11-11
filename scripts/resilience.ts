/** 分类故障、持久化熔断和故障记录，并限定安全重试。 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Store only an operational summary, never credentials or raw response bodies.
/** 依据阶段和错误类型判断限流、暂时故障或人工处理。 */
export function classifyFailure(error, stage) {
  const msg = String(error?.message || '未知错误');
  const status = error?.status ?? error?.statusCode;
  if (status === 429 || /rate.?limit|rate limited|限流|速率受限/i.test(msg)) return { kind: 'rate_limit', reason: '服务速率受限', retryable: false };
  if (stage === 'follow' || stage === 'export') return { kind: 'manual', reason: '外部操作状态需核实', retryable: false };
  if ([401, 403].includes(status) || /登录|captcha|验证码|验证|权限|connection rejected/i.test(msg)) return { kind: 'manual', reason: '登录、权限或验证问题', retryable: false };
  if (status >= 500 || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code) || /timeout|timed out|超时|connection error/i.test(msg)) return { kind: 'transient', reason: '连接或服务暂时异常', retryable: true };
  return { kind: 'manual', reason: '结果或输入需要检查', retryable: false };
}

/** 持久化服务熔断状态及每个阶段的失败记录。 */
export class ResilienceStore {
  db: DatabaseSync;
  /** 初始化熔断和故障记录所需的数据表。 */
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS circuits (scope TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failure_jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_failure ON failure_jobs(run_id,stage) WHERE status IN ('pending','manual','dead');`);
  }
  /** 读取指定服务的当前熔断状态。 */
  circuit(scope: string) { return this.db.prepare('SELECT * FROM circuits WHERE scope=?').get(scope) as { state: string; reason: string | null } | undefined; }
  /** 记录服务熔断及原因。 */
  open(scope, reason) { this.db.prepare("INSERT INTO circuits VALUES (?, 'open', ?, ?) ON CONFLICT(scope) DO UPDATE SET state='open',reason=excluded.reason,updated_at=excluded.updated_at").run(scope, reason, new Date().toISOString()); }
  /** 将指定服务的熔断状态标记为关闭。 */
  close(scope) { this.db.prepare("UPDATE circuits SET state='closed',updated_at=? WHERE scope=?").run(new Date().toISOString(), scope); }
  /** 在调用服务前拒绝处于开启状态的熔断。 */
  ensureClosed(scope) { const c = this.circuit(scope); if (c?.state === 'open') throw new Error(`${scope} 熔断已开启：${c.reason}；检查后手动解除`); }
  /** 记录阶段失败，并在重试次数耗尽时标记为待人工处理。 */
  failure(run, stage, classification) {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id,attempts FROM failure_jobs WHERE run_id=? AND stage=? AND status IN ('pending','manual','dead')").get(run, stage) as { id: string; attempts: number } | undefined;
    const attempts = (existing?.attempts || 0) + 1;
    const status = classification.retryable ? (attempts >= 3 ? 'dead' : 'pending') : 'manual';
    if (existing) this.db.prepare('UPDATE failure_jobs SET kind=?,reason=?,status=?,attempts=?,updated_at=? WHERE id=?').run(classification.kind, classification.reason, status, attempts, now, existing.id);
    else this.db.prepare('INSERT INTO failure_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), run, stage, classification.kind, classification.reason, status, attempts, now, now);
  }
  /** 将指定任务阶段的未解决故障标记为已解决。 */
  resolve(run, stage) { this.db.prepare("UPDATE failure_jobs SET status='resolved',updated_at=? WHERE run_id=? AND stage=? AND status IN ('pending','manual','dead')").run(new Date().toISOString(), run, stage); }
}

/** 只对已分类为暂时故障的操作进行有上限的退避重试。 */
export async function retryTransient(fn, { attempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), classify = e => classifyFailure(e, 'evaluate') } = {}) {
  for (let n = 1; n <= attempts; n++) {
    try { return await fn(); }
    catch (error) {
      const result = classify(error);
      if (!result.retryable || n === attempts) throw error;
      await sleep(1000 * 2 ** (n - 1));
    }
  }
}
