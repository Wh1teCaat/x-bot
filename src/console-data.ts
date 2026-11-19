/** 控制台只读快照：显式白名单输出，绝不返回账号密钥或完整运行 state。 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeLog } from './runtime-monitor.ts';

type Account = { uuid?: string | null; username?: string; name?: string | null; authenticated?: boolean };
export const stageLabels: Record<string, string> = { search: '搜索博主帖子', export: '抓取帖子回复', 'followers-export': '抓取粉丝（200 人）', filter: '整理候选用户', qualify: '筛选关注/粉丝比例', evaluate: '模型评估', follow: '写入关注队列', done: '本轮完成' };
function open(path: string) { return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null; }
function table(db: DatabaseSync | null, name: string) { return Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
export function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function sessionStatus(session: any, now: number, alive: (pid: number) => boolean) {
  if (session.ended_at != null) return session.status;
  return now - session.updated_at <= 45000 && alive(session.pid) ? 'running' : 'interrupted';
}
/** 将同一采集进程中连续的细步骤合并，耗时为记录到的各步骤耗时之和。 */
export function groupConsoleSteps(steps: any[]) {
  const grouped: any[] = [], lastBySession = new Map<string, any>();
  for (const step of [...steps].reverse()) {
    let name: string | null = null;
    if (step.worker === 'loop') {
      if (/准备采集任务/.test(step.name)) name = '预处理';
      else if (/粉丝/.test(step.name)) name = '扫描粉丝';
      else if (/帖子|搜索博主/.test(step.name)) name = '帖子扫描并加入关注队列';
    } else if (step.worker === 'clone' || step.worker === 'login') name = '预处理';
    if (!name) { lastBySession.delete(step.sessionId); continue; }
    let group = lastBySession.get(step.sessionId);
    if (!group || group.name !== name) {
      group = { ...step, name }; grouped.push(group); lastBySession.set(step.sessionId, group);
    } else {
      group.endedAt = step.endedAt;
      group.durationMs = group.durationMs == null || step.durationMs == null ? null : group.durationMs + step.durationMs;
      if (['failed', 'interrupted', 'incomplete'].includes(step.status) || !['failed', 'interrupted', 'incomplete'].includes(group.status)) group.status = step.status;
    }
  }
  return grouped.reverse().slice(0, 80);
}
export function readConsole(dataDir: string, accounts: Account[], options: { accountId?: string; before?: number; now?: number; alive?: (pid: number) => boolean } = {}) {
  const now = options.now ?? Date.now(), alive = options.alive ?? processAlive;
  const dbs: DatabaseSync[] = [];
  const connect = (name: string) => { const db = open(join(dataDir, name)); if (db) { dbs.push(db); db.exec('PRAGMA busy_timeout=1000'); } return db; };
  try {
    const runtime = connect('runtime.sqlite'), follows = connect('following.sqlite'), loop = connect('loop.sqlite');
    const allRuns = table(loop, 'runs') ? loop!.prepare('SELECT id,status,stage,state,pid,updated_at FROM runs ORDER BY updated_at DESC LIMIT 1000').all() : [];
    const result = accounts.filter(account => account.uuid && (!options.accountId || options.accountId === account.uuid)).map(account => {
      const id = account.uuid!;
      const count = (sql: string) => Number(follows!.prepare(sql).get(id)?.n ?? 0);
      const stats = {
        following: table(follows, 'follows') ? count("SELECT count(*) n FROM follows WHERE account_id=? AND status='following'") : 0,
        pending: table(follows, 'follows') ? count("SELECT count(*) n FROM follows WHERE account_id=? AND status='pending'") : 0,
        uncertain: table(follows, 'follows') ? count("SELECT count(*) n FROM follows WHERE account_id=? AND status='uncertain'") : 0,
        inbound: table(follows, 'inbound_follows') ? count('SELECT count(DISTINCT target_id) n FROM inbound_follows WHERE account_id=?') : 0,
        mutual: table(follows, 'inbound_follows') && table(follows, 'follows') ? count("SELECT count(*) n FROM follows f WHERE f.account_id=? AND f.status='following' AND EXISTS(SELECT 1 FROM inbound_follows i WHERE i.account_id=f.account_id AND i.target_id=f.target_id)") : 0,
        queued: table(follows, 'follow_outbox') ? count("SELECT count(*) n FROM follow_outbox WHERE account_id=? AND status='queued'") : 0,
        manual: table(follows, 'follow_outbox') ? count("SELECT count(*) n FROM follow_outbox WHERE account_id=? AND status='manual'") : 0,
      };
      const sessions = table(runtime, 'runtime_sessions') ? runtime!.prepare(`SELECT s.*,p.name stage,p.started_at stage_started_at,p.status stage_status FROM runtime_sessions s
        LEFT JOIN runtime_steps p ON p.id=(SELECT max(id) FROM runtime_steps WHERE session_id=s.id)
        WHERE s.account=? ORDER BY (s.ended_at IS NULL AND s.updated_at>=?) DESC,s.started_at DESC LIMIT 40`).all(id, now - 45000).map((s: any) => ({
          id: s.id, worker: s.worker, status: sessionStatus(s, now, alive), startedAt: s.started_at, updatedAt: s.updated_at,
          stage: s.stage, stageStatus: s.stage_status, stageStartedAt: s.stage_started_at,
        })) : [];
      const run = allRuns.find(row => { try { return JSON.parse(String(row.state)).followAccountId === id; } catch { return false; } });
      const fallback = run ? { id: run.id, stage: stageLabels[String(run.stage)] || String(run.stage),
        status: run.status === 'running' ? (run.pid && alive(Number(run.pid)) ? 'running' : 'interrupted') : run.status,
        updatedAt: Date.parse(String(run.updated_at)) } : null;
      const checkpoints = table(loop, 'follower_checkpoints') ? loop!.prepare('SELECT blogger,offset,due,done FROM follower_checkpoints WHERE account=?').all(id) : [];
      const nextFollowAt = table(follows, 'follow_outbox_schedule') ? follows!.prepare('SELECT next_batch_at FROM follow_outbox_schedule WHERE account_id=?').get(id)?.next_batch_at : null;
      const active = sessions.filter(s => s.status === 'running');
      const latestWorkers = new Map<string, any>();
      for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) if (!latestWorkers.has(session.worker)) latestWorkers.set(session.worker, session);
      const failed = (status: string) => ['failed', 'interrupted', 'manual', 'incomplete', 'blocked', 'verification', 'suspended'].includes(status);
      const needsAttention = stats.manual > 0 || stats.uncertain > 0 || [...latestWorkers.values()].some(s => failed(s.status) || s.stageStatus === 'failed') || Boolean(fallback && failed(String(fallback.status)) && (!sessions.length || fallback.updatedAt >= Math.max(...sessions.map(s => s.startedAt))));
      const flow = latestWorkers.get('flow');
      const terminalFlow = flow && flow.status !== 'running' && flow.updatedAt >= Math.max(...sessions.map(s => s.startedAt)) ? flow : null;
      const status = active.length ? 'running' : fallback?.status === 'running' ? 'running' : terminalFlow?.status || sessions[0]?.status || fallback?.status || 'idle';
      return { id, username: account.username || id, name: account.name || account.username || id, authorized: Boolean(account.authenticated), status, needsAttention, stats, sessions, fallback, checkpoints, nextFollowAt };
    });
    let logs: any[] = [], steps: any[] = [];
    if (options.accountId && result.length && table(runtime, 'runtime_logs')) {
      logs = runtime!.prepare(`SELECT l.id,l.level,l.message,l.created_at createdAt,l.elapsed_ms elapsedMs,p.name stage,s.worker
        FROM runtime_logs l LEFT JOIN runtime_steps p ON l.step_id=p.id JOIN runtime_sessions s ON l.session_id=s.id
        WHERE l.account=? AND l.id<? ORDER BY l.id DESC LIMIT 100`).all(options.accountId, options.before || Number.MAX_SAFE_INTEGER)
        .map(row => ({ ...row, message: safeLog(String(row.message)) }));
      steps = runtime!.prepare(`SELECT p.*,s.worker,s.pid,s.updated_at heartbeat,s.ended_at session_ended FROM runtime_steps p JOIN runtime_sessions s ON p.session_id=s.id
        WHERE p.account=? ORDER BY p.id DESC LIMIT 2000`).all(options.accountId).map((row: any) => {
          const interrupted = row.ended_at == null && (row.session_ended != null || now - row.heartbeat > 45000 || !alive(row.pid));
          return { id: row.id, sessionId: row.session_id, name: row.name, worker: row.worker, status: interrupted ? 'interrupted' : row.status, startedAt: row.started_at,
            endedAt: row.ended_at, durationMs: interrupted ? null : row.duration_ms ?? Math.max(0, now - row.started_at) };
        });
    }
    return { generatedAt: now, accounts: result, logs, steps, phaseSteps: groupConsoleSteps(steps), nextBefore: logs.length === 100 ? logs[logs.length - 1].id : null };
  } finally { for (const db of dbs) db.close(); }
}
