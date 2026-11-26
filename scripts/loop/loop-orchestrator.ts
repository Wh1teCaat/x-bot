/** 衔接单轮任务、持久化队列和 X 限流冷却。 */
import { EventWorkQueue } from './event-work-queue.ts';
import type { SetTimer, ClearTimer } from './event-work-queue.ts';
import type { DatabaseSync } from 'node:sqlite';
import { RateLimitCooldown, SqliteCooldownStore, X_COOLDOWN_MS } from './rate-limit-cooldown.ts';

type RunRow = { id: string; status: string; stage: string; state: string; pid?: number | null };
type JobRow = { id: string; status: string; owner_pid: number | null; attempts: number };
type CircuitRow = { state: string; updated_at: string };

/** 组装持久化单轮队列、恢复探测和失败处理。 */
export function createLoopOrchestrator({ db, runId, execute, probe, hasUncertain = async (_row) => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onLog = (_message: string) => {} }: {
  db: DatabaseSync; runId: string; execute: (options: { runId: string; resume: boolean }) => Promise<number>;
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
  let probedCircuit: CircuitRow | undefined;
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
      const failure = row && db.prepare("SELECT * FROM failure_jobs WHERE run_id=? AND stage=? AND status!='resolved' ORDER BY updated_at DESC LIMIT 1").get(runId, row.stage);
      const circuit = db.prepare("SELECT state FROM circuits WHERE scope='x'").get();
      if (row?.stage === 'follow-lookup' && failure?.kind === 'rate_limit') {
        const retryAt = Number(JSON.parse(row.state).lookupRetryAt);
        const due = Number.isFinite(retryAt) ? Math.max(now() + X_COOLDOWN_MS, retryAt) : now() + X_COOLDOWN_MS;
        db.prepare("UPDATE loop_jobs SET status='ready',due=?,last_error=? WHERE id=?").run(due, 'X 用户查询限流', runId);
        onLog(`X 用户查询限流，${new Date(due).toISOString()} 后重试只读查询。`);
        return;
      }
      if (['search', 'followers-export', 'qualify'].includes(row?.stage) && (failure?.kind === 'rate_limit' || circuit?.state === 'open')) {
        db.prepare("UPDATE loop_jobs SET status='cooldown',last_error=? WHERE id=?").run('X 限流', runId);
        await cooldown.limited();
        onLog(`X ${row.stage === 'followers-export' ? '粉丝导出' : row.stage === 'qualify' ? '主页读取' : '帖子读取'}受限：至少冷却 15 分钟，再进行只读探测。`);
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
    if ((row?.stage === 'export' || (row?.stage === 'followers-export' && !JSON.parse(row.state).followerBatchMode)) && row.status !== 'running') throw new Error('导出结果需人工核实');
    const result = await execute({ runId, resume: Boolean(row) });
    if (result !== 0) throw new Error(`单轮任务退出码 ${result}`);
    if (getRun()?.status !== 'completed') throw new Error('单轮任务未完成，需人工检查');
  }, onError: error => { onLog(`队列错误：${error instanceof Error ? error.message : String(error)}`); finishOnce('error'); } });
  // 多个采集任务共享页面冷却，只允许领取探测资格的进程确认恢复。
  const cooldown = new RateLimitCooldown({ store: new SqliteCooldownStore(db, 'x'), now, setTimer, clearTimer,
    probe: async () => {
      probedCircuit = db.prepare("SELECT state,updated_at FROM circuits WHERE scope='x'").get() as CircuitRow | undefined;
      return probe(getRun());
    },
    confirmRecovery: () => {
      const current = db.prepare("SELECT state,updated_at FROM circuits WHERE scope='x'").get() as CircuitRow | undefined;
      if (!current || current.state === 'closed') return true;
      if (current.updated_at !== probedCircuit?.updated_at || current.state !== probedCircuit.state) return false;
      db.prepare("UPDATE circuits SET state='closed',updated_at=? WHERE scope='x'").run(new Date(now()).toISOString());
      return true;
    },
    onRecovered: async () => {
      const state = db.prepare("SELECT state FROM circuits WHERE scope='x'").get()?.state;
      if (state === 'open' || state === 'half_open') { await cooldown.limited(); return; }
      if (db.prepare("UPDATE loop_jobs SET status='ready',due=? WHERE id=? AND status='cooldown' AND owner_pid=?").run(now(), runId, process.pid).changes)
        onLog('页面限流已恢复，继续采集任务。');
      queue.wake();
    },
    onError: error => { onLog(`冷却调度失败：${String(error)}`); finishOnce('error'); },
  });
  return {
    /** 恢复已有冷却或断点，并等待本轮完成、停止或进入人工处理。 */
    async start() {
      const job = getJob();
      const current = getRun();
      const circuit = db.prepare("SELECT * FROM circuits WHERE scope='x'").get() as CircuitRow | undefined;
      if (job?.status === 'ready') { queue.wake(); return done; }
      if (job?.status === 'cooldown') {
        if (job.owner_pid && alive(job.owner_pid)) { finishOnce('manual'); return done; }
        const claimed = db.prepare("UPDATE loop_jobs SET owner_pid=? WHERE id=? AND status='cooldown' AND owner_pid IS ?").run(process.pid, runId, job.owner_pid);
        if (!claimed.changes) { finishOnce('manual'); return done; }
        if (current?.stage === 'follow') {
          const state = JSON.parse(current.state);
          if (state.version !== 5 || state.followConfirmation || state.follow?.matched?.some(item => item.status !== 'queued') || await hasUncertain(current)) {
            db.prepare("UPDATE loop_jobs SET status='manual',owner_pid=NULL,last_error=? WHERE id=?").run('旧关注进度需核实', runId);
            finishOnce('manual'); return done;
          }
          const due = Math.max(now(), await cooldown.store.getNext() ?? now());
          db.prepare("UPDATE loop_jobs SET status='ready',due=?,owner_pid=NULL WHERE id=?").run(due, runId);
          queue.wake(); return done;
        }
        if (circuit?.state === 'half_open') db.prepare("UPDATE circuits SET state='open',updated_at=? WHERE scope='x'").run(new Date(now()).toISOString());
        if (await cooldown.store.getNext() == null) await cooldown.limited();
        else await cooldown.start();
        return done;
      }
      if (job?.status === 'running') {
        const row = getRun();
        if (alive(job.owner_pid) || alive(row?.pid) || !row || !['search', 'filter', 'qualify', 'evaluate', 'follow-lookup'].includes(row.stage)) { finishOnce('manual'); return done; }
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
