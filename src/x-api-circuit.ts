import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** 按令牌和接口隔离 X API 熔断；令牌只以哈希参与定位。 */
export class XApiCircuit {
  constructor(db: DatabaseSync, now = Date.now) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS x_api_circuits (
      scope TEXT PRIMARY KEY, state TEXT NOT NULL, failures INTEGER NOT NULL, next_at INTEGER NOT NULL
    )`);
  }
  private db: DatabaseSync;
  private now: () => number;
  key(path: string, method: string, authorization: string) {
    const endpoint = path.split('?')[0].split('/').map(segment => /^\d{1,19}$/.test(segment) ? ':id' : segment).join('/');
    const identity = createHash('sha256').update(authorization).digest('hex');
    return `${method.toUpperCase()}:${endpoint}:${identity}`;
  }
  /** 返回 false 表示熔断；超时后只允许一个真实请求作为半开探测。 */
  allow(scope: string): boolean {
    const row = this.db.prepare('SELECT state,next_at FROM x_api_circuits WHERE scope=?').get(scope) as { state: string; next_at: number } | undefined;
    if (!row || row.state === 'closed') return true;
    if (row.next_at > this.now()) return false;
    return !!this.db.prepare("UPDATE x_api_circuits SET state='half_open',next_at=? WHERE scope=? AND state=? AND next_at=?").run(this.now() + 60_000, scope, row.state, row.next_at).changes;
  }
  success(scope: string) { this.db.prepare('DELETE FROM x_api_circuits WHERE scope=?').run(scope); }
  reject(scope: string) {
    const row = this.db.prepare('SELECT state FROM x_api_circuits WHERE scope=?').get(scope) as {state: string} | undefined;
    if (row?.state === 'half_open') this.failure(scope, 503);
    else this.success(scope);
  }
  failure(scope: string, status: number, retryAfterMs = 0) {
    const row = this.db.prepare('SELECT state,failures FROM x_api_circuits WHERE scope=?').get(scope) as {state: string; failures: number} | undefined;
    const failures = (row?.failures || 0) + 1;
    const open = status === 429 || row?.state === 'half_open' || failures >= 3;
    const next = open ? this.now() + Math.max(15 * 60_000, retryAfterMs) : 0;
    this.db.prepare('INSERT INTO x_api_circuits VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state,failures=excluded.failures,next_at=excluded.next_at').run(scope, open ? 'open' : 'closed', failures, next);
  }
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const time = Date.parse(header);
  return Number.isFinite(time) ? Math.max(0, time - now) : 0;
}

export function rateLimitDelay(headers: Headers, now = Date.now()): number {
  const reset = headers.get('x-rate-limit-reset');
  const resetMs = reset && /^\d+$/.test(reset.trim()) ? Math.max(0, Number(reset.trim()) * 1000 - now) : 0;
  return Math.max(retryAfterMs(headers.get('retry-after'), now), resetMs);
}

/** 为直接调用 X 的独立进程复用相同的持久熔断存储。 */
export async function fetchXWithCircuit(url: string, init: RequestInit, path = '.data/x-api-circuits.sqlite'): Promise<Response> {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const circuit = new XApiCircuit(db);
    const scope = circuit.key(new URL(url).pathname, init.method || 'GET', new Headers(init.headers).get('authorization') || '');
    if (!circuit.allow(scope)) throw Object.assign(new Error('X API HTTP 429: 熔断冷却中'), { status: 429 });
    let response: Response;
    try { response = await fetch(url, init); }
    catch (error) { if (!init.signal?.aborted || init.signal.reason?.name === 'TimeoutError') circuit.failure(scope, 503); throw error; }
    if (response.status === 429 || response.status >= 500) circuit.failure(scope, response.status, rateLimitDelay(response.headers));
    else if (!response.ok) circuit.reject(scope);
    else circuit.success(scope);
    return response;
  } finally { db.close(); }
}
