/** 本地多进程运行记录；只用于展示，记录失败不影响业务执行。 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format } from 'node:util';

export function safeLog(value: string): string {
  // 外部响应可能夹带认证数据；整条隐藏，避免把凭据写进展示日志。
  if (/auth_token|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization\s*[:=]|bearer\s+|["']ct0["']|cookie\s*[:=]/i.test(value)) return '[包含认证字段的日志已隐藏]';
  return value.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 3000);
}
export class RuntimeMonitor {
  db: DatabaseSync;
  id = randomUUID();
  account: string;
  stepId: number | null = null;
  stageName = '';
  started = 0;
  closed = false;
  now: () => number;
  constructor(path: string, account: string, worker: string, now = Date.now) {
    this.account = account; this.now = now;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS runtime_sessions(id TEXT PRIMARY KEY,account TEXT NOT NULL,worker TEXT NOT NULL,pid INTEGER NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS runtime_steps(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,account TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,duration_ms INTEGER);
      CREATE TABLE IF NOT EXISTS runtime_logs(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,account TEXT NOT NULL,step_id INTEGER,level TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL,elapsed_ms INTEGER);
      CREATE INDEX IF NOT EXISTS runtime_logs_account ON runtime_logs(account,id);
      CREATE INDEX IF NOT EXISTS runtime_steps_account ON runtime_steps(account,id);
      CREATE INDEX IF NOT EXISTS runtime_sessions_account ON runtime_sessions(account,updated_at);`);
    this.db.prepare('INSERT INTO runtime_sessions VALUES (?,?,?,?,?,?,?,NULL)').run(this.id, account, worker, process.pid, 'running', now(), now());
  }
  heartbeat() { this.db.prepare('UPDATE runtime_sessions SET updated_at=? WHERE id=?').run(this.now(), this.id); }
  stage(name: string, status = 'running') {
    if (this.closed) return;
    if (name === this.stageName && this.stepId !== null) return;
    this.finishStep('completed');
    this.started = this.now(); this.stageName = name;
    const row = this.db.prepare('INSERT INTO runtime_steps(session_id,account,name,status,started_at) VALUES (?,?,?,?,?)').run(this.id, this.account, name, status, this.started);
    this.stepId = Number(row.lastInsertRowid);
    this.heartbeat();
  }
  finishStep(status: string) {
    if (this.stepId === null) return;
    const end = this.now();
    this.db.prepare('UPDATE runtime_steps SET status=?,ended_at=?,duration_ms=? WHERE id=?').run(status, end, Math.max(0, end - this.started), this.stepId);
    this.stepId = null;
  }
  log(level: string, message: string) {
    if (this.closed) return;
    this.db.prepare('INSERT INTO runtime_logs(session_id,account,step_id,level,message,created_at,elapsed_ms) VALUES (?,?,?,?,?,?,?)')
      .run(this.id, this.account, this.stepId, level, safeLog(message), this.now(), this.stepId === null ? null : Math.max(0, this.now() - this.started));
  }
  close(status = 'completed') {
    if (this.closed) return;
    this.finishStep(status);
    this.db.prepare('UPDATE runtime_sessions SET status=?,updated_at=?,ended_at=? WHERE id=?').run(status, this.now(), this.now(), this.id);
    this.closed = true; this.db.close();
  }
}

export type Telemetry = { endStep: (status: string) => void; stage: (name: string, status?: string) => void; finish: (status?: string) => void };
/** 共享 Activity 流可能收到其他账号的事件，按事件目标单独归档。 */
export function recordRuntimeEvent(account: string, message: string) {
  if (!/^\d{1,19}$/.test(account)) return;
  let monitor: RuntimeMonitor | undefined;
  try {
    monitor = new RuntimeMonitor(resolve('.data/runtime.sqlite'), account, 'activity');
    monitor.stage('收到关注事件');
    monitor.log('info', message);
  } catch { /* 不影响事件持久化。 */ }
  finally { try { monitor?.close(); } catch {} }
}
/** 每个业务子进程独立记录；不把其他账号的 stdout 混进当前账号。 */
export function monitorProcess(account: string | undefined, worker: string): Telemetry {
  const noop = { endStep: (_status: string) => {}, stage: (_name: string, _status?: string) => {}, finish: (_status?: string) => {} };
  if (!account || !/^\d{1,19}$/.test(account)) return noop;
  let monitor: RuntimeMonitor;
  try { monitor = new RuntimeMonitor(resolve('.data/runtime.sqlite'), account, worker); } catch { return noop; }
  const attempt = (fn: () => void) => { try { fn(); } catch { /* 展示记录不阻断业务。 */ } };
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const key of ['log', 'warn', 'error'] as const) {
    console[key] = (...args: any[]) => {
      original[key](...args);
      attempt(() => monitor.log(key === 'log' ? 'info' : key, format(...args)));
    };
  }
  const timer = setInterval(() => attempt(() => monitor.heartbeat()), 10000);
  timer.unref();
  let finished = false;
  const finish = (status = 'completed') => {
    if (finished) return; finished = true;
    clearInterval(timer);
    Object.assign(console, original);
    attempt(() => monitor.close(status));
  };
  process.once('uncaughtExceptionMonitor', () => finish('failed'));
  process.once('exit', code => finish(code ? 'failed' : 'completed'));
  return { endStep: status => attempt(() => monitor.finishStep(status)), stage: (name, status) => attempt(() => monitor.stage(name, status)), finish };
}
