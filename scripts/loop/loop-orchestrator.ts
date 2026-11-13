/** 衔接单轮任务、持久化队列和 X 限流冷却。 */
import { EventWorkQueue } from './event-work-queue.ts';
import type { SetTimer, ClearTimer } from './event-work-queue.ts';
import type { DatabaseSync } from 'node:sqlite';
import { RateLimitCooldown, SqliteCooldownStore } from './rate-limit-cooldown.ts';

type RunRow = { id: string; status: string; stage: string; state: string; pid?: number | null };
type JobRow = { id: string; status: string; owner_pid: number | null; attempts: number };
type CircuitRow = { state: string; updated_at: string };

// At most one verified follow is permitted while X is half-open.
/** 组装持久化单轮队列、恢复探测和失败处理。 */
export function createLoopOrchestrator({ db, runId, execute, probe, hasUncertain = async (_row) => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onLog = (_message: string) => {} }: {
  db: DatabaseSync; runId: string; execute: (options: { runId: string; resume: boolean; probe?: boolean }) => Promise<number>;
  probe: (row: any) => Promise<boolean>; hasUncertain?: (row: any) => Promise<boolean>; now?: () => number;
  setTimer?: SetTimer; clearTimer?: ClearTimer; onLog?: (message: string) => void;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS loop_jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, due INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, owner_pid INTEGER
  )`);
  if (!db.prepare('PRAGMA table_info(loop_jobs)').all().some(column => column.name === 'owner_pid')) db.exec('ALTER TABLE loop_jobs ADD COLUMN owner_pid INTEGER');
  const getJob = () => db.prepare('SELECT * FROM loop_jobs WHERE id=?').get(runId) as JobRow | undefined;
  const getRun = () => db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
  const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  let finish, done = new Promise(resolve => { finish = resolve; });
  let finished = false;
  const finishOnce = status => { if (!finished) { finished = true; queue.close(); cooldown.close(); finish(status); } };
  // 队列只管理当前轮的状态；实际的阶段断点保存在 runs 表中。
  const store = {
    enqueue: async () => {
      const result = db.prepare("INSERT INTO loop_jobs(id,status,due) VALUES (?, 'ready', ?) ON CONFLICT(id) DO UPDATE SET status='ready',due=excluded.due,last_error=NULL WHERE loop_jobs.status NOT IN ('running','cooldown')").run(runId, now());
      if (!result.changes) throw new Error('队列任务正在执行或冷却');
    },
    claimReady: async () => {
      const result = db.prepare("UPDATE loop_jobs SET status='running',due=NULL,owner_pid=? WHERE id=? AND status='ready' AND due<=?").run(process.pid, runId, now());
      return result.changes ? { id: runId } : null;
    },
    complete: async () => { db.prepare("UPDATE loop_jobs SET status='done',due=NULL WHERE id=?").run(runId); finishOnce('completed'); },
    nextDue: async () => (db.prepare("SELECT due FROM loop_jobs WHERE id=? AND status='ready'").get(runId) as { due: number } | undefined)?.due ?? null,
    fail: async (_, error) => {
      const row = getRun();
      const failure = db.prepare("SELECT * FROM failure_jobs WHERE run_id=? AND stage=? AND status!='resolved' ORDER BY updated_at DESC LIMIT 1").get(runId, row?.stage);
      const circuit = db.prepare("SELECT state FROM circuits WHERE scope='x'").get();
      if (['search', 'qualify', 'follow'].includes(row?.stage) && (failure?.kind === 'rate_limit' || circuit?.state === 'open')) {
        if (row.stage === 'follow' && await hasUncertain(row)) {
          db.prepare("UPDATE loop_jobs SET status='manual',last_error=? WHERE id=?").run('关注结果不明，需核实', runId);
          finishOnce('manual'); return;
        }
        db.prepare("UPDATE loop_jobs SET status='cooldown',last_error=? WHERE id=?").run('X 限流', runId);
        await cooldown.limited();
        onLog(`X ${row.stage === 'follow' ? '关注' : row.stage === 'qualify' ? '主页读取' : '帖子读取'}受限：15 分钟后进入半开探测。`);
        return;
      }
      if (row?.stage === 'evaluate' && failure?.kind === 'transient' && failure.status === 'pending') {
        // The LLM circuit remains open after exhaustion; do not silently clear it.
        db.prepare("UPDATE loop_jobs SET status='manual',last_error=? WHERE id=?").run('模型熔断需检查', runId); finishOnce('manual'); return;
      }
      db.prepare("UPDATE loop_jobs SET status='manual',last_error=? WHERE id=?").run(String(error.message || '执行失败').slice(0, 200), runId);
      finishOnce('manual');
    },
  };
  const queue = new EventWorkQueue({ store, now, setTimer, clearTimer, handle: async () => {
    const row = getRun();
    if (row?.status === 'completed') return;
    if (row?.stage === 'export' && row.status !== 'running') throw new Error('导出结果需人工核实');
    const result = await execute({ runId, resume: Boolean(row) });
    if (result !== 0) throw new Error(`单轮任务退出码 ${result}`);
    if (getRun()?.status !== 'completed') throw new Error('单轮任务未完成，需人工检查');
  }, onError: error => { onLog(`队列错误：${error instanceof Error ? error.message : String(error)}`); finishOnce('error'); } });
  // 搜索用只读探测，关注只允许一次新的请求，结果不明时停止。
  const cooldown = new RateLimitCooldown({ store: new SqliteCooldownStore(db, 'x'), now, setTimer, clearTimer,
    probe: async () => {
      const row = getRun();
      if (row?.stage !== 'follow') return probe(row);
      if (await hasUncertain(row)) {
        db.prepare("UPDATE loop_jobs SET status='manual',last_error=? WHERE id=?").run('关注结果不明，需核实', runId);
        finishOnce('manual'); return false;
      }
      db.prepare("UPDATE circuits SET state='half_open',updated_at=? WHERE scope='x' AND state='open'").run(new Date(now()).toISOString());
      if (db.prepare("SELECT state FROM circuits WHERE scope='x'").get()?.state !== 'half_open') return false;
      onLog('X 进入半开：最多尝试关注一名未处理用户。');
      let code;
      try { code = await execute({ runId, resume: true, probe: true }); } catch { code = 1; }
      const success = code === 0 && getRun()?.status === 'probe_succeeded' && db.prepare("SELECT state FROM circuits WHERE scope='x'").get()?.state === 'half_open';
      if (!success) {
        db.prepare("UPDATE circuits SET state='open',updated_at=? WHERE scope='x'").run(new Date(now()).toISOString());
        if (await hasUncertain(getRun())) {
          db.prepare("UPDATE loop_jobs SET status='manual',last_error=? WHERE id=?").run('关注结果不明，需核实', runId);
          finishOnce('manual');
        } else onLog('半开探测未确认恢复，继续冷却。');
      }
      return success;
    },
    onRecovered: async () => {
      db.prepare("UPDATE circuits SET state='closed',updated_at=? WHERE scope='x'").run(new Date(now()).toISOString());
      onLog('半开探测成功，恢复任务。');
      db.prepare("UPDATE loop_jobs SET status='ready',due=? WHERE id=? AND status='cooldown' AND owner_pid=?").run(now(), runId, process.pid);
      queue.wake();
    },
  });
  return {
    /** 恢复已有冷却或断点，并等待本轮完成、停止或进入人工处理。 */
    async start() {
      const job = getJob();
      const current = getRun();
      const circuit = db.prepare("SELECT * FROM circuits WHERE scope='x'").get() as CircuitRow | undefined;
      if (job?.status === 'manual' && current?.stage === 'follow' && circuit?.state === 'open') {
        if (await hasUncertain(current)) { finishOnce('manual'); return done; }
        db.prepare("UPDATE loop_jobs SET status='cooldown',owner_pid=NULL,last_error=? WHERE id=? AND status='manual'").run('X 限流', runId);
        const updated = Date.parse(circuit.updated_at);
        await cooldown.store.setNext(Math.max(now(), Number.isFinite(updated) ? updated + 15 * 60 * 1000 : now() + 15 * 60 * 1000));
        onLog('已恢复关注冷却任务，等待半开探测。');
        return this.start();
      }
      if (job?.status === 'cooldown') {
        if (job.owner_pid && alive(job.owner_pid)) { finishOnce('manual'); return done; }
        const claimed = db.prepare("UPDATE loop_jobs SET owner_pid=? WHERE id=? AND status='cooldown' AND owner_pid IS ?").run(process.pid, runId, job.owner_pid);
        if (!claimed.changes) { finishOnce('manual'); return done; }
        if (circuit?.state === 'half_open') db.prepare("UPDATE circuits SET state='open',updated_at=? WHERE scope='x'").run(new Date(now()).toISOString());
        if (await cooldown.store.getNext() == null) await cooldown.limited();
        else await cooldown.start();
        return done;
      }
      if (job?.status === 'running') {
        const row = getRun();
        if (alive(job.owner_pid) || alive(row?.pid) || !row || !['search', 'filter', 'qualify', 'evaluate'].includes(row.stage)) { finishOnce('manual'); return done; }
        const claimed = db.prepare("UPDATE loop_jobs SET status='manual',owner_pid=NULL WHERE id=? AND status='running' AND owner_pid IS ?").run(runId, job.owner_pid);
        if (!claimed.changes) { finishOnce('manual'); return done; }
        onLog('发现中断的只读阶段，将从持久化断点恢复。');
      }
      await queue.enqueue({ id: runId });
      return done;
    },
    /** 停止本进程的队列并释放其持有的冷却任务。 */
    close() {
      db.prepare("UPDATE loop_jobs SET owner_pid=NULL WHERE id=? AND owner_pid=? AND status='cooldown'").run(runId, process.pid);
      finishOnce('stopped');
    },
  };
}
